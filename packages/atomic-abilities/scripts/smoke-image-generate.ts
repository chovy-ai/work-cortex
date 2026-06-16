// 端到端冒烟：经 ACP 调 codex 生图，校验产出合 schema + 图片真落盘，打印相对路径与 workspace。
// 运行：npm run smoke:image（需 codex-acp 已装 + codex 认证就绪 + codex 具备生图能力）
import { imageGenerate, AbilityOutputError } from "../index.js";

try {
  const out = await imageGenerate({ prompt: "一只戴墨镜的柴犬，扁平插画风", ratio: "1:1" });
  console.log("✅ image.generate 产出（已过 output schema + 文件存在核验）：");
  console.log(JSON.stringify(out, null, 2));
  console.log("workspace（绝对）：", out.workspace);
} catch (err) {
  if (err instanceof AbilityOutputError) {
    console.error("产出 / 文件核验未过：", err.message);
  } else {
    console.error("冒烟失败：", err);
  }
  process.exitCode = 1;
}
