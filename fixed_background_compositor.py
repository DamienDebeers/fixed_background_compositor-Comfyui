from __future__ import annotations

import hashlib
import json
import os
import secrets
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths

try:
    from aiohttp import web
    from server import PromptServer
except Exception:  # pragma: no cover - unavailable outside ComfyUI runtime
    web = None
    PromptServer = None

try:  # Newer ComfyUI
    from comfy_execution.graph import ExecutionBlocker
except Exception:  # pragma: no cover - compatibility fallback
    try:
        from execution import ExecutionBlocker  # type: ignore
    except Exception:  # pragma: no cover
        ExecutionBlocker = None  # type: ignore


PLUGIN_VERSION = "1.2.0"
MAX_LAYERS = 5
NODE_STATE: dict[str, dict[str, Any]] = {}


def _first_frame(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise TypeError("Expected a torch.Tensor IMAGE input")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise ValueError(f"Expected IMAGE shape [B,H,W,C], got {tuple(image.shape)}")
    return image[:1]


def tensor_to_pil(image: torch.Tensor) -> Image.Image:
    frame = _first_frame(image)[0].detach().cpu().float().clamp(0.0, 1.0).numpy()
    if frame.shape[-1] == 1:
        array = (frame[..., 0] * 255.0).round().astype(np.uint8)
        return Image.fromarray(array, mode="L")
    if frame.shape[-1] >= 4:
        array = (frame[..., :4] * 255.0).round().astype(np.uint8)
        return Image.fromarray(array, mode="RGBA")
    array = (frame[..., :3] * 255.0).round().astype(np.uint8)
    return Image.fromarray(array, mode="RGB")


def pil_to_tensor(image: Image.Image) -> torch.Tensor:
    rgb = image.convert("RGB")
    array = np.asarray(rgb).astype(np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def mask_tensor_to_pil(mask: torch.Tensor) -> Image.Image:
    """Convert a ComfyUI MASK tensor to an 8-bit grayscale PIL image.

    Standard ComfyUI MASK tensors use shape [B,H,W]. A few custom nodes emit
    [B,H,W,1], which is also accepted here. Only the first batch item is used.
    """
    if not isinstance(mask, torch.Tensor):
        raise TypeError("Expected a torch.Tensor MASK input")

    value = mask.detach().cpu().float()
    if value.ndim == 4:
        value = value[0]
        if value.ndim == 3:
            value = value[..., 0]
    elif value.ndim == 3:
        value = value[0]
    elif value.ndim != 2:
        raise ValueError(f"Expected MASK shape [B,H,W] or [B,H,W,1], got {tuple(mask.shape)}")

    array = (value.clamp(0.0, 1.0).numpy() * 255.0).round().astype(np.uint8)
    return Image.fromarray(array, mode="L")


def _merge_layer_mask(layer: Image.Image, mask: Image.Image | None, mask_mode: str) -> Image.Image:
    """Apply an optional ComfyUI mask to a layer's alpha channel.

    `ComfyUI Load Image alpha` matches the mask emitted by ComfyUI's standard
    Load Image node: transparent pixels are white, so the mask is inverted to
    obtain visible alpha. `White = visible` treats white directly as opacity.
    Existing RGBA alpha from the IMAGE input is multiplied by the mask.
    """
    rgba = layer.convert("RGBA")
    if mask is None:
        return rgba

    if mask.size != rgba.size:
        mask = mask.resize(rgba.size, Image.Resampling.BILINEAR)

    mask_array = np.asarray(mask, dtype=np.float32) / 255.0
    if mask_mode == "ComfyUI Load Image alpha":
        visibility = 1.0 - mask_array
    else:
        visibility = mask_array

    alpha = np.asarray(rgba.getchannel("A"), dtype=np.float32) / 255.0
    combined = np.clip(alpha * visibility, 0.0, 1.0)
    rgba.putalpha(Image.fromarray((combined * 255.0).round().astype(np.uint8), mode="L"))
    return rgba


def _default_transform(index: int, source_w: int, source_h: int, canvas_w: int, canvas_h: int) -> dict[str, Any]:
    safe_w = max(1, source_w)
    safe_h = max(1, source_h)
    fit = min(1.0, (canvas_w * 0.45) / safe_w, (canvas_h * 0.45) / safe_h)
    offset = (index - 2) * 18
    return {
        "x": canvas_w / 2 + offset,
        "y": canvas_h / 2 + offset,
        "scaleX": fit,
        "scaleY": fit,
        "rotation": 0.0,
        "opacity": 1.0,
        "visible": True,
        "flipX": False,
        "flipY": False,
        "z": index,
    }


def _number(value: Any, default: float) -> float:
    try:
        result = float(value)
        if np.isfinite(result):
            return result
    except (TypeError, ValueError):
        pass
    return default


def _normalise_transform(raw: Any, default: dict[str, Any], index: int) -> dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        "x": _number(raw.get("x"), float(default["x"])),
        "y": _number(raw.get("y"), float(default["y"])),
        "scaleX": max(0.005, min(100.0, _number(raw.get("scaleX"), float(default["scaleX"])))),
        "scaleY": max(0.005, min(100.0, _number(raw.get("scaleY"), float(default["scaleY"])))),
        "rotation": _number(raw.get("rotation"), 0.0) % 360.0,
        "opacity": max(0.0, min(1.0, _number(raw.get("opacity"), 1.0))),
        "visible": bool(raw.get("visible", True)),
        "flipX": bool(raw.get("flipX", False)),
        "flipY": bool(raw.get("flipY", False)),
        "z": int(_number(raw.get("z"), float(index))),
    }


def _normalise_transform_json(
    transform_json: str,
    layer_sizes: list[tuple[int, int] | None],
    canvas_w: int,
    canvas_h: int,
) -> tuple[list[dict[str, Any]], str]:
    try:
        data = json.loads(transform_json or "{}")
    except json.JSONDecodeError:
        data = {}

    raw_layers = data.get("layers", []) if isinstance(data, dict) else []
    transforms: list[dict[str, Any]] = []
    for index, size in enumerate(layer_sizes):
        source_w, source_h = size if size is not None else (1, 1)
        default = _default_transform(index, source_w, source_h, canvas_w, canvas_h)
        raw = raw_layers[index] if index < len(raw_layers) else {}
        transforms.append(_normalise_transform(raw, default, index))

    normalised = {
        "version": 1,
        "canvasWidth": canvas_w,
        "canvasHeight": canvas_h,
        "layers": transforms,
    }
    return transforms, json.dumps(normalised, ensure_ascii=False, separators=(",", ":"))


def _parse_transform_json(
    transform_json: str,
    layers: list[Image.Image | None],
    canvas_w: int,
    canvas_h: int,
) -> tuple[list[dict[str, Any]], str]:
    layer_sizes = [layer.size if layer is not None else None for layer in layers]
    return _normalise_transform_json(transform_json, layer_sizes, canvas_w, canvas_h)


def _apply_layer(base: Image.Image, layer: Image.Image, transform: dict[str, Any]) -> Image.Image:
    if not transform["visible"] or transform["opacity"] <= 0.0:
        return base

    foreground = layer.convert("RGBA")
    if transform["flipX"]:
        foreground = ImageOps.mirror(foreground)
    if transform["flipY"]:
        foreground = ImageOps.flip(foreground)

    new_w = max(1, round(foreground.width * transform["scaleX"]))
    new_h = max(1, round(foreground.height * transform["scaleY"]))
    if (new_w, new_h) != foreground.size:
        foreground = foreground.resize((new_w, new_h), Image.Resampling.LANCZOS)

    opacity = transform["opacity"]
    if opacity < 1.0:
        alpha = foreground.getchannel("A").point(lambda p: round(p * opacity))
        foreground.putalpha(alpha)

    rotation = transform["rotation"]
    if abs(rotation) > 1e-6:
        foreground = foreground.rotate(-rotation, expand=True, resample=Image.Resampling.BICUBIC)

    left = round(transform["x"] - foreground.width / 2)
    top = round(transform["y"] - foreground.height / 2)
    base.alpha_composite(foreground, dest=(left, top))
    return base


def _save_preview(image: Image.Image, node_id: str, slot: str) -> dict[str, str]:
    preview = image.convert("RGBA")
    digest = hashlib.sha1(preview.tobytes()).hexdigest()[:14]
    subfolder = "fixed_background_compositor"
    directory = os.path.join(folder_paths.get_temp_directory(), subfolder)
    os.makedirs(directory, exist_ok=True)
    safe_node_id = "".join(ch for ch in str(node_id) if ch.isalnum() or ch in "-_") or "node"
    filename = f"fbc_{safe_node_id}_{slot}_{digest}.png"
    path = os.path.join(directory, filename)
    if not os.path.exists(path):
        preview.save(path, format="PNG", compress_level=1)
    return {"filename": filename, "subfolder": subfolder, "type": "temp"}


def _input_signature(background: Image.Image, layers: list[Image.Image | None]) -> str:
    sha1 = hashlib.sha1()

    def _push_image(tag: str, image: Image.Image | None):
        sha1.update(tag.encode("utf-8"))
        if image is None:
            sha1.update(b"<none>")
            return
        image_rgba = image.convert("RGBA")
        sha1.update(f"{image_rgba.width}x{image_rgba.height}:{image_rgba.mode}".encode("utf-8"))
        sha1.update(image_rgba.tobytes())

    _push_image("background", background)
    for index, layer in enumerate(layers, start=1):
        _push_image(f"layer_{index}", layer)
    return sha1.hexdigest()


def _node_state(node_id: str) -> dict[str, Any]:
    return NODE_STATE.setdefault(str(node_id), {})


def _make_blocker(message: str):
    if ExecutionBlocker is None:
        return None
    try:
        return ExecutionBlocker(message)
    except TypeError:
        try:
            return ExecutionBlocker(None)
        except Exception:
            return None


class FixedBackgroundCompositor:
    """A fixed-background visual compositor with five movable foreground layers."""

    @classmethod
    def INPUT_TYPES(cls):
        # Keep all layer IMAGE sockets first so existing v1.1.x workflow links
        # retain their original socket positions. New MASK sockets are appended.
        optional: dict[str, Any] = {}
        for index in range(1, MAX_LAYERS + 1):
            optional[f"layer_{index}"] = (
                "IMAGE",
                {"tooltip": f"Optional movable foreground layer {index}. RGBA alpha is preserved when present."},
            )
        for index in range(1, MAX_LAYERS + 1):
            optional[f"mask_{index}"] = (
                "MASK",
                {"tooltip": f"Optional alpha mask for layer {index}. Connect the matching MASK output here."},
            )
        return {
            "required": {
                "background": (
                    "IMAGE",
                    {"tooltip": "Fixed background. Its first frame determines the output resolution."},
                ),
                "transform_json": (
                    "STRING",
                    {
                        "default": '{"version":1,"layers":[]}',
                        "multiline": True,
                        "dynamicPrompts": False,
                        "tooltip": "Managed automatically by the visual editor.",
                    },
                ),
                "confirm_token": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": False,
                        "tooltip": "Internal one-time confirmation token managed by the visual editor.",
                    },
                ),
                "mask_mode": (
                    ["ComfyUI Load Image alpha", "White = visible"],
                    {
                        "default": "ComfyUI Load Image alpha",
                        "tooltip": (
                            "ComfyUI Load Image alpha: invert the standard Load Image MASK, where transparent areas are white. "
                            "White = visible: use white areas directly as visible alpha for segmentation masks."
                        ),
                    },
                ),
            },
            "optional": optional,
            "hidden": {"node_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "transforms")
    FUNCTION = "compose"
    CATEGORY = "image/compositing"
    DESCRIPTION = (
        "Uses the background as a locked canvas and visually positions up to five foreground images. "
        "Each foreground can receive an optional MASK so transparent subjects remain transparent in the editor and output. "
        "The node pauses downstream execution until you click Confirm, then automatically re-queues and continues."
    )

    def compose(
        self,
        background: torch.Tensor,
        transform_json: str,
        confirm_token: str = "",
        mask_mode: str = "ComfyUI Load Image alpha",
        node_id: str = "node",
        **kwargs,
    ):
        node_id = str(node_id)
        background_pil = tensor_to_pil(background).convert("RGBA")
        canvas_w, canvas_h = background_pil.size

        layer_pils: list[Image.Image | None] = []
        masked_layer_count = 0
        for index in range(1, MAX_LAYERS + 1):
            value = kwargs.get(f"layer_{index}")
            if value is None:
                layer_pils.append(None)
                continue

            layer = tensor_to_pil(value).convert("RGBA")
            mask_value = kwargs.get(f"mask_{index}")
            mask = mask_tensor_to_pil(mask_value) if mask_value is not None else None
            if mask is not None:
                masked_layer_count += 1
            layer_pils.append(_merge_layer_mask(layer, mask, mask_mode))

        transforms, normalised_json = _parse_transform_json(
            transform_json=transform_json,
            layers=layer_pils,
            canvas_w=canvas_w,
            canvas_h=canvas_h,
        )

        composite = background_pil.copy()
        order = sorted(
            (index for index, layer in enumerate(layer_pils) if layer is not None),
            key=lambda index: (transforms[index]["z"], index),
        )
        for index in order:
            composite = _apply_layer(composite, layer_pils[index], transforms[index])

        state = _node_state(node_id)
        current_input_signature = _input_signature(background_pil, layer_pils)
        state["latest_input_signature"] = current_input_signature
        state["latest_canvas_width"] = canvas_w
        state["latest_canvas_height"] = canvas_h
        state["latest_layer_sizes"] = [layer.size if layer is not None else None for layer in layer_pils]
        state["latest_transform_json"] = normalised_json

        confirm_token = str(confirm_token or "")
        confirmed = (
            bool(confirm_token)
            and state.get("confirmed_token") == confirm_token
            and state.get("confirmed_input_signature") == current_input_signature
            and state.get("confirmed_transform_json") == normalised_json
        )

        background_meta = _save_preview(background_pil, node_id, "background")
        layer_metas: list[dict[str, str] | None] = []
        layer_sizes: list[dict[str, int] | None] = []
        for index, layer in enumerate(layer_pils):
            if layer is None:
                layer_metas.append(None)
                layer_sizes.append(None)
            else:
                layer_metas.append(_save_preview(layer, node_id, f"layer{index + 1}"))
                layer_sizes.append({"width": layer.width, "height": layer.height})

        payload = {
            "version": PLUGIN_VERSION,
            "nodeId": node_id,
            "canvasWidth": canvas_w,
            "canvasHeight": canvas_h,
            "background": background_meta,
            "layers": layer_metas,
            "layerSizes": layer_sizes,
            "transforms": normalised_json,
            "confirmed": confirmed,
            "requiresConfirm": True,
            "maskedLayerCount": masked_layer_count,
            "maskMode": mask_mode,
        }

        if not confirmed and ExecutionBlocker is not None:
            blocker = _make_blocker("Edit the layers in the node and click Confirm to continue.")
            return {
                "ui": {"fixed_compositor": [payload]},
                "result": (blocker, blocker),
            }

        # If confirmed or blocker support is unavailable, continue normally.
        return {
            "ui": {"fixed_compositor": [payload]},
            "result": (pil_to_tensor(composite), normalised_json),
        }


if PromptServer is not None and web is not None:  # pragma: no cover - only active in ComfyUI runtime

    @PromptServer.instance.routes.post("/fixed_background_compositor/confirm")
    async def fixed_background_compositor_confirm(request):
        try:
            data = await request.json()
        except Exception:
            data = {}

        node_id = str(data.get("node_id", "") or "")
        transform_json = data.get("transform_json", "") or ""
        if not node_id:
            return web.json_response({"ok": False, "error": "Missing node_id"}, status=400)

        state = _node_state(node_id)
        input_signature = state.get("latest_input_signature")
        canvas_w = int(state.get("latest_canvas_width") or 0)
        canvas_h = int(state.get("latest_canvas_height") or 0)
        layer_sizes = state.get("latest_layer_sizes") or []

        if not input_signature or not canvas_w or not canvas_h:
            return web.json_response(
                {
                    "ok": False,
                    "error": "No pending preview data. Please queue the workflow once before confirming.",
                },
                status=400,
            )

        # Normalize the transform JSON so it matches backend comparisons on the next queued run.
        _, normalised_json = _normalise_transform_json(
            transform_json=transform_json,
            layer_sizes=[tuple(size) if size is not None else None for size in layer_sizes],
            canvas_w=canvas_w,
            canvas_h=canvas_h,
        )

        token = secrets.token_urlsafe(24)
        state["confirmed_token"] = token
        state["confirmed_input_signature"] = input_signature
        state["confirmed_transform_json"] = normalised_json

        return web.json_response({"ok": True, "node_id": node_id, "confirm_token": token})


NODE_CLASS_MAPPINGS = {"FixedBackgroundCompositor": FixedBackgroundCompositor}
NODE_DISPLAY_NAME_MAPPINGS = {"FixedBackgroundCompositor": "💜 Fixed Background Compositor"}
