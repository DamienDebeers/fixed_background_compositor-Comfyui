import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "FixedBackgroundCompositor";
const MAX_LAYERS = 5;
const MAX_PREVIEW_WIDTH = 1400;
const MAX_PREVIEW_HEIGHT = 900;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parseJson(value, fallback = {}) {
    try {
        const parsed = JSON.parse(value || "{}");
        return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function viewUrl(meta) {
    if (!meta) return null;
    const params = new URLSearchParams({
        filename: meta.filename || "",
        type: meta.type || "temp",
        subfolder: meta.subfolder || "",
    });
    params.set("_", String(Date.now()));
    return api.apiURL(`/view?${params.toString()}`);
}

function loadImage(meta) {
    return new Promise((resolve) => {
        if (!meta) {
            resolve(null);
            return;
        }
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = viewUrl(meta);
    });
}

function makeButton(text, title, accent = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = title || text;
    Object.assign(button.style, {
        border: accent ? "1px solid #8f54ff" : "1px solid var(--border-color, #555)",
        borderRadius: "6px",
        padding: "4px 8px",
        background: accent ? "#6e3dff" : "var(--comfy-input-bg, #222)",
        color: "#fff",
        cursor: "pointer",
        fontSize: "12px",
        lineHeight: "18px",
        fontWeight: accent ? "600" : "400",
    });
    return button;
}

function defaultTransform(index, sourceWidth, sourceHeight, canvasWidth, canvasHeight) {
    const width = Math.max(1, sourceWidth || 1);
    const height = Math.max(1, sourceHeight || 1);
    const fit = Math.min(1, (canvasWidth * 0.45) / width, (canvasHeight * 0.45) / height);
    const offset = (index - 2) * 18;
    return {
        x: canvasWidth / 2 + offset,
        y: canvasHeight / 2 + offset,
        scaleX: fit,
        scaleY: fit,
        rotation: 0,
        opacity: 1,
        visible: true,
        flipX: false,
        flipY: false,
        z: index,
    };
}

function normalizeTransform(raw, fallback, index) {
    raw = raw && typeof raw === "object" ? raw : {};
    const finite = (value, defaultValue) => Number.isFinite(Number(value)) ? Number(value) : defaultValue;
    return {
        x: finite(raw.x, fallback.x),
        y: finite(raw.y, fallback.y),
        scaleX: clamp(finite(raw.scaleX, fallback.scaleX), 0.005, 100),
        scaleY: clamp(finite(raw.scaleY, fallback.scaleY), 0.005, 100),
        rotation: ((finite(raw.rotation, 0) % 360) + 360) % 360,
        opacity: clamp(finite(raw.opacity, 1), 0, 1),
        visible: raw.visible !== false,
        flipX: raw.flipX === true,
        flipY: raw.flipY === true,
        z: Math.trunc(finite(raw.z, index)),
    };
}

async function postJson(path, body) {
    const fetcher = api.fetchApi?.bind(api) || fetch.bind(window);
    const response = await fetcher(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
}

async function queueCurrentPrompt() {
    if (typeof app.queuePrompt === "function") {
        try {
            return await app.queuePrompt(0);
        } catch (_) {
            // fall through
        }
    }

    if (typeof app.graphToPrompt === "function" && typeof api.queuePrompt === "function") {
        const prompt = await app.graphToPrompt();
        return await api.queuePrompt(0, prompt);
    }

    const queueButton = Array.from(document.querySelectorAll("button")).find((button) => {
        const text = (button.textContent || "").trim().toLowerCase();
        return text === "queue" || text.includes("queue prompt") || text.includes("排队") || text.includes("运行");
    });
    if (queueButton) {
        queueButton.click();
        return;
    }

    throw new Error("Unable to automatically queue the prompt in this ComfyUI frontend version.");
}

class FixedCompositorEditor {
    constructor(node, transformWidget, confirmWidget) {
        this.node = node;
        this.transformWidget = transformWidget;
        this.confirmWidget = confirmWidget;
        this.canvasWidth = 512;
        this.canvasHeight = 512;
        this.renderScale = 1;
        this.backgroundImage = null;
        this.layerImages = Array(MAX_LAYERS).fill(null);
        this.layerSizes = Array(MAX_LAYERS).fill(null);
        this.transforms = Array(MAX_LAYERS).fill(null).map((_, index) =>
            defaultTransform(index, 1, 1, this.canvasWidth, this.canvasHeight)
        );
        this.selected = -1;
        this.pointerAction = null;
        this.serverNodeId = String(node?.id ?? "");
        this.requiresConfirm = true;
        this.confirmed = false;
        this.confirmBusy = false;
        this.buildUi();
        this.draw();
    }

    buildUi() {
        const root = document.createElement("div");
        Object.assign(root.style, {
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            width: "100%",
            padding: "4px",
            boxSizing: "border-box",
            color: "var(--input-text, #ddd)",
            fontFamily: "sans-serif",
            userSelect: "none",
        });

        const toolbar = document.createElement("div");
        Object.assign(toolbar.style, {
            display: "flex",
            flexWrap: "wrap",
            gap: "4px",
            alignItems: "center",
        });

        const confirmButton = makeButton("Confirm & Continue", "确认当前排版并自动继续执行下游工作流", true);
        const resetButton = makeButton("重置图层", "恢复当前图层的初始位置和尺寸");
        const resetAllButton = makeButton("全部重置", "恢复所有前景图层");
        const centerButton = makeButton("居中", "将当前图层移到背景中心");
        const fitButton = makeButton("适应画布", "等比例缩放当前图层，使其适应背景");
        const downButton = makeButton("下移一层", "降低当前图层的叠放顺序");
        const upButton = makeButton("上移一层", "提高当前图层的叠放顺序");
        const flipXButton = makeButton("水平翻转", "水平翻转当前图层");
        const flipYButton = makeButton("垂直翻转", "垂直翻转当前图层");
        const visibleButton = makeButton("显示/隐藏", "切换当前图层可见性");

        [
            confirmButton,
            resetButton,
            resetAllButton,
            centerButton,
            fitButton,
            downButton,
            upButton,
            flipXButton,
            flipYButton,
            visibleButton,
        ].forEach((button) => toolbar.appendChild(button));

        const opacityWrap = document.createElement("label");
        Object.assign(opacityWrap.style, {
            display: "flex",
            gap: "5px",
            alignItems: "center",
            marginLeft: "2px",
            fontSize: "12px",
        });
        opacityWrap.textContent = "透明度";
        const opacity = document.createElement("input");
        opacity.type = "range";
        opacity.min = "0";
        opacity.max = "1";
        opacity.step = "0.01";
        opacity.value = "1";
        opacity.style.width = "100px";
        opacityWrap.appendChild(opacity);
        toolbar.appendChild(opacityWrap);

        const canvasWrap = document.createElement("div");
        Object.assign(canvasWrap.style, {
            width: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            border: "1px solid var(--border-color, #555)",
            borderRadius: "7px",
            overflow: "hidden",
            backgroundColor: "#777",
            backgroundImage:
                "linear-gradient(45deg,#999 25%,transparent 25%),linear-gradient(-45deg,#999 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#999 75%),linear-gradient(-45deg,transparent 75%,#999 75%)",
            backgroundSize: "20px 20px",
            backgroundPosition: "0 0,0 10px,10px -10px,-10px 0px",
        });

        const canvas = document.createElement("canvas");
        canvas.tabIndex = 0;
        Object.assign(canvas.style, {
            display: "block",
            width: "100%",
            height: "auto",
            outline: "none",
            touchAction: "none",
            cursor: "default",
        });
        canvasWrap.appendChild(canvas);

        const status = document.createElement("div");
        Object.assign(status.style, {
            display: "flex",
            justifyContent: "space-between",
            gap: "8px",
            fontSize: "12px",
            opacity: "0.9",
            minHeight: "18px",
        });
        const statusLeft = document.createElement("span");
        statusLeft.textContent = "先运行一次工作流以载入背景和前景图层";
        const statusRight = document.createElement("span");
        statusRight.textContent = "拖动 / 滚轮缩放 / 顶部圆点旋转 / Confirm继续";
        status.append(statusLeft, statusRight);

        root.append(toolbar, canvasWrap, status);
        this.root = root;
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.opacityInput = opacity;
        this.statusLeft = statusLeft;
        this.statusRight = statusRight;
        this.confirmButton = confirmButton;

        confirmButton.addEventListener("click", () => this.confirmAndContinue());
        resetButton.addEventListener("click", () => this.resetSelected());
        resetAllButton.addEventListener("click", () => this.resetAll());
        centerButton.addEventListener("click", () => this.centerSelected());
        fitButton.addEventListener("click", () => this.fitSelected());
        downButton.addEventListener("click", () => this.moveLayer(-1));
        upButton.addEventListener("click", () => this.moveLayer(1));
        flipXButton.addEventListener("click", () => this.toggleFlip("flipX"));
        flipYButton.addEventListener("click", () => this.toggleFlip("flipY"));
        visibleButton.addEventListener("click", () => this.toggleVisible());
        opacity.addEventListener("input", () => {
            const transform = this.currentTransform();
            if (!transform) return;
            transform.opacity = Number(opacity.value);
            this.commit();
            this.draw();
        });

        canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
        canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
        canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
        canvas.addEventListener("pointercancel", (event) => this.onPointerUp(event));
        canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
        canvas.addEventListener("keydown", (event) => this.onKeyDown(event));
    }

    updateConfirmButtonState() {
        if (!this.confirmButton) return;
        this.confirmButton.disabled = this.confirmBusy || !this.backgroundImage;
        this.confirmButton.style.opacity = this.confirmButton.disabled ? "0.55" : "1";
        this.confirmButton.textContent = this.confirmBusy
            ? "Confirming…"
            : (this.confirmed ? "Confirmed · Click to Re-Run" : "Confirm & Continue");
    }

    async loadPayload(payload) {
        if (!payload || typeof payload !== "object") return;
        this.statusLeft.textContent = "正在载入预览…";
        this.serverNodeId = String(payload.nodeId || this.node?.id || "");
        this.requiresConfirm = payload.requiresConfirm !== false;
        this.confirmed = payload.confirmed === true;
        this.confirmBusy = false;
        this.updateConfirmButtonState();

        this.canvasWidth = Math.max(1, Number(payload.canvasWidth) || 512);
        this.canvasHeight = Math.max(1, Number(payload.canvasHeight) || 512);
        this.renderScale = Math.min(
            1,
            MAX_PREVIEW_WIDTH / this.canvasWidth,
            MAX_PREVIEW_HEIGHT / this.canvasHeight
        );
        this.canvas.width = Math.max(1, Math.round(this.canvasWidth * this.renderScale));
        this.canvas.height = Math.max(1, Math.round(this.canvasHeight * this.renderScale));
        this.canvas.style.aspectRatio = `${this.canvasWidth} / ${this.canvasHeight}`;
        const maxCssWidth = Math.max(280, Math.min(520, (Number(this.node.size?.[0]) || 560) - 24));
        const maxCssHeight = 620;
        const cssScale = Math.min(maxCssWidth / this.canvasWidth, maxCssHeight / this.canvasHeight);
        const cssWidth = Math.max(1, Math.round(this.canvasWidth * cssScale));
        const cssHeight = Math.max(1, Math.round(this.canvasHeight * cssScale));
        this.canvas.style.width = `${cssWidth}px`;
        this.canvas.style.height = `${cssHeight}px`;
        const desiredNodeHeight = Math.max(Number(this.node.size?.[1]) || 0, cssHeight + 190);
        this.node.setSize?.([Math.max(Number(this.node.size?.[0]) || 0, 560), desiredNodeHeight]);

        const layerMeta = Array.isArray(payload.layers) ? payload.layers.slice(0, MAX_LAYERS) : [];
        while (layerMeta.length < MAX_LAYERS) layerMeta.push(null);
        const [backgroundImage, ...layerImages] = await Promise.all([
            loadImage(payload.background),
            ...layerMeta.map((meta) => loadImage(meta)),
        ]);
        this.backgroundImage = backgroundImage;
        this.layerImages = layerImages;
        this.layerSizes = Array.isArray(payload.layerSizes)
            ? payload.layerSizes.slice(0, MAX_LAYERS)
            : layerImages.map((image) => image ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        while (this.layerSizes.length < MAX_LAYERS) this.layerSizes.push(null);

        const payloadData = parseJson(payload.transforms, {});
        const widgetData = parseJson(this.transformWidget?.value, {});
        const sourceLayers = Array.isArray(widgetData.layers) && widgetData.layers.length
            ? widgetData.layers
            : (Array.isArray(payloadData.layers) ? payloadData.layers : []);

        this.transforms = Array(MAX_LAYERS).fill(null).map((_, index) => {
            const size = this.getSourceSize(index);
            const fallback = defaultTransform(index, size.width, size.height, this.canvasWidth, this.canvasHeight);
            return normalizeTransform(sourceLayers[index], fallback, index);
        });

        if (this.selected < 0 || !this.layerImages[this.selected]) {
            this.selected = this.topmostLayerIndex();
        }
        this.syncControls();
        this.commit(false);
        const count = this.layerImages.filter(Boolean).length;
        const maskedCount = Math.max(0, Number(payload.maskedLayerCount) || 0);
        const maskInfo = maskedCount > 0 ? `，蒙版 ${maskedCount} 层` : "";
        this.statusLeft.textContent = this.requiresConfirm
            ? (this.confirmed
                ? `已确认，背景 ${this.canvasWidth}×${this.canvasHeight}，前景 ${count} 层${maskInfo}`
                : `已暂停在本节点：背景 ${this.canvasWidth}×${this.canvasHeight}，前景 ${count} 层${maskInfo}；调整后点击 Confirm`)
            : `背景 ${this.canvasWidth}×${this.canvasHeight}，已载入 ${count} 个前景图层${maskInfo}`;
        this.updateConfirmButtonState();
        this.draw();
    }

    getSourceSize(index) {
        const size = this.layerSizes[index];
        const image = this.layerImages[index];
        return {
            width: Math.max(1, Number(size?.width) || image?.naturalWidth || 1),
            height: Math.max(1, Number(size?.height) || image?.naturalHeight || 1),
        };
    }

    currentTransform() {
        if (this.selected < 0 || !this.layerImages[this.selected]) return null;
        return this.transforms[this.selected];
    }

    topmostLayerIndex() {
        const indexes = this.layerImages
            .map((image, index) => image ? index : -1)
            .filter((index) => index >= 0)
            .sort((a, b) => (this.transforms[b]?.z ?? b) - (this.transforms[a]?.z ?? a));
        return indexes.length ? indexes[0] : -1;
    }

    worldPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * (this.canvasWidth / Math.max(1, rect.width));
        const y = (event.clientY - rect.top) * (this.canvasHeight / Math.max(1, rect.height));
        return { x, y };
    }

    localPoint(index, point) {
        const transform = this.transforms[index];
        const radians = -transform.rotation * Math.PI / 180;
        const dx = point.x - transform.x;
        const dy = point.y - transform.y;
        return {
            x: dx * Math.cos(radians) - dy * Math.sin(radians),
            y: dx * Math.sin(radians) + dy * Math.cos(radians),
        };
    }

    layerGeometry(index) {
        const transform = this.transforms[index];
        const size = this.getSourceSize(index);
        return {
            width: size.width * transform.scaleX,
            height: size.height * transform.scaleY,
        };
    }

    rotateLocal(index, localX, localY) {
        const transform = this.transforms[index];
        const radians = transform.rotation * Math.PI / 180;
        return {
            x: transform.x + localX * Math.cos(radians) - localY * Math.sin(radians),
            y: transform.y + localX * Math.sin(radians) + localY * Math.cos(radians),
        };
    }

    hitLayer(point) {
        return this.layerImages
            .map((image, index) => image ? index : -1)
            .filter((index) => index >= 0 && this.transforms[index].visible)
            .sort((a, b) => (this.transforms[b].z - this.transforms[a].z) || (b - a))
            .find((index) => {
                const local = this.localPoint(index, point);
                const geometry = this.layerGeometry(index);
                return Math.abs(local.x) <= geometry.width / 2 && Math.abs(local.y) <= geometry.height / 2;
            }) ?? -1;
    }

    handleHit(point) {
        if (this.selected < 0 || !this.layerImages[this.selected]) return null;
        const geometry = this.layerGeometry(this.selected);
        const radius = 12 / Math.max(0.01, this.renderScale);
        const corners = [
            [-geometry.width / 2, -geometry.height / 2],
            [geometry.width / 2, -geometry.height / 2],
            [geometry.width / 2, geometry.height / 2],
            [-geometry.width / 2, geometry.height / 2],
        ];
        for (const [x, y] of corners) {
            const world = this.rotateLocal(this.selected, x, y);
            if (Math.hypot(point.x - world.x, point.y - world.y) <= radius) return "scale";
        }
        const rotationPoint = this.rotateLocal(
            this.selected,
            0,
            -geometry.height / 2 - 34 / Math.max(0.01, this.renderScale)
        );
        if (Math.hypot(point.x - rotationPoint.x, point.y - rotationPoint.y) <= radius * 1.2) {
            return "rotate";
        }
        return null;
    }

    onPointerDown(event) {
        if (event.button !== 0) return;
        this.canvas.focus();
        const point = this.worldPoint(event);
        const handle = this.handleHit(point);
        if (handle && this.selected >= 0) {
            const transform = this.transforms[this.selected];
            this.pointerAction = {
                type: handle,
                index: this.selected,
                start: point,
                startScaleX: transform.scaleX,
                startScaleY: transform.scaleY,
                startDistance: Math.max(1, Math.hypot(point.x - transform.x, point.y - transform.y)),
                startRotation: transform.rotation,
                startAngle: Math.atan2(point.y - transform.y, point.x - transform.x),
            };
        } else {
            const hit = this.hitLayer(point);
            this.selected = hit;
            this.syncControls();
            if (hit >= 0) {
                const transform = this.transforms[hit];
                this.pointerAction = {
                    type: "move",
                    index: hit,
                    start: point,
                    startX: transform.x,
                    startY: transform.y,
                };
            }
        }
        this.canvas.setPointerCapture?.(event.pointerId);
        this.draw();
        event.preventDefault();
        event.stopPropagation();
    }

    onPointerMove(event) {
        if (!this.pointerAction) return;
        const point = this.worldPoint(event);
        const action = this.pointerAction;
        const transform = this.transforms[action.index];
        if (action.type === "move") {
            transform.x = action.startX + point.x - action.start.x;
            transform.y = action.startY + point.y - action.start.y;
        } else if (action.type === "scale") {
            const distance = Math.max(1, Math.hypot(point.x - transform.x, point.y - transform.y));
            const ratio = distance / action.startDistance;
            transform.scaleX = clamp(action.startScaleX * ratio, 0.005, 100);
            transform.scaleY = clamp(action.startScaleY * ratio, 0.005, 100);
        } else if (action.type === "rotate") {
            const angle = Math.atan2(point.y - transform.y, point.x - transform.x);
            let degrees = action.startRotation + (angle - action.startAngle) * 180 / Math.PI;
            if (event.shiftKey) degrees = Math.round(degrees / 5) * 5;
            transform.rotation = ((degrees % 360) + 360) % 360;
        }
        this.draw();
        event.preventDefault();
        event.stopPropagation();
    }

    onPointerUp(event) {
        if (!this.pointerAction) return;
        this.pointerAction = null;
        this.canvas.releasePointerCapture?.(event.pointerId);
        this.commit();
        this.draw();
        event.preventDefault();
        event.stopPropagation();
    }

    onWheel(event) {
        const transform = this.currentTransform();
        if (!transform) return;
        const factor = Math.exp(-event.deltaY * 0.001);
        transform.scaleX = clamp(transform.scaleX * factor, 0.005, 100);
        transform.scaleY = clamp(transform.scaleY * factor, 0.005, 100);
        this.commit();
        this.draw();
        event.preventDefault();
        event.stopPropagation();
    }

    onKeyDown(event) {
        const transform = this.currentTransform();
        if (!transform) return;
        const step = event.shiftKey ? 10 : 1;
        let handled = true;
        if (event.key === "ArrowLeft") transform.x -= step;
        else if (event.key === "ArrowRight") transform.x += step;
        else if (event.key === "ArrowUp") transform.y -= step;
        else if (event.key === "ArrowDown") transform.y += step;
        else handled = false;
        if (handled) {
            this.commit();
            this.draw();
            event.preventDefault();
            event.stopPropagation();
        }
    }

    resetSelected() {
        if (this.selected < 0 || !this.layerImages[this.selected]) return;
        const size = this.getSourceSize(this.selected);
        this.transforms[this.selected] = defaultTransform(
            this.selected,
            size.width,
            size.height,
            this.canvasWidth,
            this.canvasHeight
        );
        this.commit();
        this.syncControls();
        this.draw();
    }

    resetAll() {
        this.transforms = this.transforms.map((_, index) => {
            const size = this.getSourceSize(index);
            return defaultTransform(index, size.width, size.height, this.canvasWidth, this.canvasHeight);
        });
        this.commit();
        this.syncControls();
        this.draw();
    }

    centerSelected() {
        const transform = this.currentTransform();
        if (!transform) return;
        transform.x = this.canvasWidth / 2;
        transform.y = this.canvasHeight / 2;
        this.commit();
        this.draw();
    }

    fitSelected() {
        const transform = this.currentTransform();
        if (!transform) return;
        const size = this.getSourceSize(this.selected);
        const scale = Math.min((this.canvasWidth * 0.8) / size.width, (this.canvasHeight * 0.8) / size.height);
        transform.scaleX = scale;
        transform.scaleY = scale;
        transform.x = this.canvasWidth / 2;
        transform.y = this.canvasHeight / 2;
        transform.rotation = 0;
        this.commit();
        this.draw();
    }

    moveLayer(direction) {
        const transform = this.currentTransform();
        if (!transform) return;
        const zValues = this.transforms.filter(Boolean).map((item) => item.z);
        transform.z = direction > 0 ? Math.max(...zValues) + 1 : Math.min(...zValues) - 1;
        this.normalizeZ();
        this.commit();
        this.draw();
    }

    normalizeZ() {
        const ordered = this.transforms
            .map((transform, index) => ({ transform, index }))
            .sort((a, b) => (a.transform.z - b.transform.z) || (a.index - b.index));
        ordered.forEach((item, z) => { item.transform.z = z; });
    }

    toggleFlip(key) {
        const transform = this.currentTransform();
        if (!transform) return;
        transform[key] = !transform[key];
        this.commit();
        this.draw();
    }

    toggleVisible() {
        const transform = this.currentTransform();
        if (!transform) return;
        transform.visible = !transform.visible;
        this.commit();
        this.draw();
    }

    syncControls() {
        const transform = this.currentTransform();
        this.opacityInput.disabled = !transform;
        if (transform) this.opacityInput.value = String(transform.opacity);
    }

    commit(markDirty = true) {
        const value = JSON.stringify({
            version: 1,
            canvasWidth: this.canvasWidth,
            canvasHeight: this.canvasHeight,
            layers: this.transforms,
        });
        if (this.transformWidget) {
            this.transformWidget.value = value;
            this.transformWidget.callback?.(value);
        }
        if (markDirty) {
            // Any visual edit invalidates the previous confirmation token.
            // Clearing this hidden input also changes the prompt cache key.
            if (this.confirmWidget) {
                this.confirmWidget.value = "";
                this.confirmWidget.callback?.("");
            }
            this.confirmed = false;
            this.updateConfirmButtonState();
            this.node.graph?.setDirtyCanvas?.(true, true);
            this.node.setDirtyCanvas?.(true, true);
        }
    }

    async confirmAndContinue() {
        if (this.confirmBusy) return;
        if (!this.backgroundImage) {
            this.statusLeft.textContent = "请先运行一次工作流，让节点载入背景和图层。";
            return;
        }
        if (!this.requiresConfirm) {
            this.statusLeft.textContent = "当前版本未启用确认机制。";
            return;
        }

        this.commit(false);
        this.confirmBusy = true;
        this.updateConfirmButtonState();
        this.statusLeft.textContent = "正在确认当前排版…";

        try {
            const response = await postJson("/fixed_background_compositor/confirm", {
                node_id: this.serverNodeId,
                transform_json: this.transformWidget?.value || JSON.stringify({ layers: this.transforms }),
            });
            const token = String(response?.confirm_token || "");
            if (!token) throw new Error("The server did not return a confirmation token.");

            // The token is an actual node input. Updating it guarantees that ComfyUI
            // cannot reuse the cached ExecutionBlocker from the preview pass.
            if (this.confirmWidget) {
                this.confirmWidget.value = token;
                this.confirmWidget.callback?.(token);
            } else {
                throw new Error("confirm_token widget is missing. Restart ComfyUI and hard-refresh the browser.");
            }
            this.node.graph?.setDirtyCanvas?.(true, true);
            this.node.setDirtyCanvas?.(true, true);

            this.confirmed = true;
            this.statusLeft.textContent = "已确认，正在强制重新执行本节点并继续下游…";
            this.updateConfirmButtonState();
            await queueCurrentPrompt();
        } catch (error) {
            console.error(error);
            this.confirmed = false;
            this.statusLeft.textContent = `确认失败：${error?.message || error}`;
        } finally {
            this.confirmBusy = false;
            this.updateConfirmButtonState();
        }
    }

    draw() {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();
        ctx.scale(this.renderScale, this.renderScale);

        if (this.backgroundImage) {
            ctx.drawImage(this.backgroundImage, 0, 0, this.canvasWidth, this.canvasHeight);
        } else {
            ctx.fillStyle = "rgba(30,30,30,0.8)";
            ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
            ctx.fillStyle = "rgba(255,255,255,0.75)";
            ctx.font = `${18 / Math.max(0.25, this.renderScale)}px sans-serif`;
            ctx.textAlign = "center";
            ctx.fillText("运行工作流后在这里编辑构图", this.canvasWidth / 2, this.canvasHeight / 2);
        }

        const order = this.layerImages
            .map((image, index) => image ? index : -1)
            .filter((index) => index >= 0)
            .sort((a, b) => (this.transforms[a].z - this.transforms[b].z) || (a - b));

        for (const index of order) {
            const image = this.layerImages[index];
            const transform = this.transforms[index];
            if (!image || !transform.visible || transform.opacity <= 0) continue;
            const geometry = this.layerGeometry(index);
            ctx.save();
            ctx.translate(transform.x, transform.y);
            ctx.rotate(transform.rotation * Math.PI / 180);
            ctx.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
            ctx.globalAlpha = transform.opacity;
            ctx.drawImage(image, -geometry.width / 2, -geometry.height / 2, geometry.width, geometry.height);
            ctx.restore();
        }

        this.drawSelection(ctx);
        ctx.restore();
    }

    drawSelection(ctx) {
        if (this.selected < 0 || !this.layerImages[this.selected]) return;
        const transform = this.transforms[this.selected];
        const geometry = this.layerGeometry(this.selected);
        const lineWidth = 2 / Math.max(0.01, this.renderScale);
        const handleRadius = 6 / Math.max(0.01, this.renderScale);
        const rotationGap = 34 / Math.max(0.01, this.renderScale);

        ctx.save();
        ctx.translate(transform.x, transform.y);
        ctx.rotate(transform.rotation * Math.PI / 180);
        ctx.strokeStyle = transform.visible ? "#b36cff" : "#888";
        ctx.fillStyle = "#ffffff";
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(transform.visible ? [] : [8 / this.renderScale, 5 / this.renderScale]);
        ctx.strokeRect(-geometry.width / 2, -geometry.height / 2, geometry.width, geometry.height);
        ctx.setLineDash([]);

        const corners = [
            [-geometry.width / 2, -geometry.height / 2],
            [geometry.width / 2, -geometry.height / 2],
            [geometry.width / 2, geometry.height / 2],
            [-geometry.width / 2, geometry.height / 2],
        ];
        for (const [x, y] of corners) {
            ctx.beginPath();
            ctx.arc(x, y, handleRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(0, -geometry.height / 2);
        ctx.lineTo(0, -geometry.height / 2 - rotationGap);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, -geometry.height / 2 - rotationGap, handleRadius * 1.15, 0, Math.PI * 2);
        ctx.fillStyle = "#b36cff";
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
}

app.registerExtension({
    name: "damien.FixedBackgroundCompositor",

    async nodeCreated(node) {
        if (
            node.comfyClass !== NODE_CLASS &&
            node.type !== NODE_CLASS &&
            node.constructor?.comfyClass !== NODE_CLASS
        ) return;

        const transformWidget = node.widgets?.find((widget) => widget.name === "transform_json");
        const confirmWidget = node.widgets?.find((widget) => widget.name === "confirm_token");
        for (const widget of [transformWidget, confirmWidget]) {
            if (!widget) continue;
            widget.origType = widget.type;
            widget.origComputeSize = widget.computeSize;
            widget.type = "converted-widget";
            widget.computeSize = () => [0, -4];
            if (widget.inputEl) {
                widget.inputEl.style.display = "none";
                widget.inputEl.parentElement && (widget.inputEl.parentElement.style.display = "none");
            }
        }

        const editor = new FixedCompositorEditor(node, transformWidget, confirmWidget);
        node._fixedBackgroundCompositor = editor;
        node.addDOMWidget("fixed_compositor_editor", "fixed_compositor_editor", editor.root, {
            serialize: false,
            hideOnZoom: false,
        });

        const originalExecuted = node.onExecuted;
        node.onExecuted = function (message) {
            const result = originalExecuted?.apply(this, arguments);
            let payload = message?.fixed_compositor;
            while (Array.isArray(payload) && payload.length === 1) payload = payload[0];
            this._fixedBackgroundCompositor?.loadPayload(payload);
            return result;
        };

        const width = Math.max(Number(node.size?.[0]) || 0, 560);
        const height = Math.max(Number(node.size?.[1]) || 0, 690);
        node.setSize?.([width, height]);
    },
});
