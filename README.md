# 💜 Fixed Background Compositor

固定背景、最多五层前景的 ComfyUI 可视化合成节点。

## V1.2.0：透明图与 MASK 支持

ComfyUI 标准 `IMAGE` 通常只有 RGB 三通道。透明 PNG 的 Alpha 往往会被 `Load Image` 单独输出为 `MASK`，因此仅连接 `IMAGE` 时，节点无法知道哪些区域应该透明。

V1.2.0 为每个前景增加了对应蒙版输入：

```text
layer_1 + mask_1
layer_2 + mask_2
layer_3 + mask_3
layer_4 + mask_4
layer_5 + mask_5
```

节点会在后端把 IMAGE 和 MASK 合并成 RGBA，因此：

- 节点编辑画布显示透明结果；
- 最终合成使用同一份透明 Alpha；
- MASK 与 IMAGE 尺寸不同时会自动缩放匹配；
- 原 IMAGE 自带 RGBA Alpha 时仍会保留；
- 同时连接 RGBA Alpha 和 MASK 时，两者会相乘。

### `mask_mode`

提供两种蒙版解释方式：

```text
ComfyUI Load Image alpha
White = visible
```

#### ComfyUI Load Image alpha（默认）

适用于 ComfyUI 原生 `Load Image` 的 MASK 输出：

- 白色代表原图透明区域；
- 黑色代表原图可见区域；
- 节点会自动反转后作为 Alpha。

#### White = visible

适用于一般抠图、分割节点输出的主体蒙版：

- 白色区域可见；
- 黑色区域透明。

---

## Confirm & Continue

1. 第一次运行到本节点时，下游暂停。
2. 在节点中移动、缩放、旋转和调整图层。
3. 点击 `Confirm & Continue`。
4. 插件写入一次性确认令牌并自动重新排队。
5. 第二次运行正式输出合成图，并继续执行下游。

V1.1.1 起使用 `confirm_token` 强制打破暂停结果缓存，避免点击 Confirm 后任务瞬间结束而没有真实输出。

---

## 节点输入

```text
background     固定背景
layer_1        前景图层 1
layer_2        前景图层 2
layer_3        前景图层 3
layer_4        前景图层 4
layer_5        前景图层 5
mask_1         图层 1 Alpha 蒙版
mask_2         图层 2 Alpha 蒙版
mask_3         图层 3 Alpha 蒙版
mask_4         图层 4 Alpha 蒙版
mask_5         图层 5 Alpha 蒙版
mask_mode      蒙版解释方式
```

## 节点输出

```text
image          最终合成 IMAGE
transforms     图层变换 JSON
```

---

## 透明 PNG 推荐连接

原生 `Load Image`：

```text
Load Image IMAGE ── Resize Image ────────── layer_1
Load Image MASK  ───────────────────────── mask_1
```

MASK 不必提前缩放，节点会自动把它调整到 `layer_1` 的实际尺寸。

默认保持：

```text
mask_mode = ComfyUI Load Image alpha
```

如果连接的是 BiRefNet、分割或其他“白色主体”的蒙版：

```text
mask_mode = White = visible
```

---

## 可视化编辑功能

- 背景固定，不可选择或移动；
- 最多五个前景；
- 拖动位置；
- 滚轮等比例缩放；
- 四角控制点缩放；
- 顶部圆点旋转；
- Shift 旋转时按 5° 吸附；
- 方向键移动 1 像素；
- Shift + 方向键移动 10 像素；
- 居中、适应画布；
- 水平/垂直翻转；
- 透明度；
- 显示/隐藏；
- 调整图层顺序；
- Confirm 后自动继续。

---

## 安装

将文件夹放到：

```text
ComfyUI/custom_nodes/ComfyUI-FixedBackgroundCompositor
```

重启 ComfyUI 后，浏览器执行：

```text
Ctrl + F5
```

搜索：

```text
💜 Fixed Background Compositor
```
