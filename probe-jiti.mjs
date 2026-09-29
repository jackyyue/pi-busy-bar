import { createJiti } from "file:///C:/nvm/v22.22.0/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("./pi-busy-bar.ts", import.meta.url));
const jiti = createJiti(import.meta.url);

// 阳性对照：pi 实际用的 jiti 管线能加载真实扩展文件并拿到 default 工厂
const good = await jiti.import(EXT);
console.log("GOOD default export:", typeof good.default);

// 阴性对照：证明这条探测链路真的能测出坏文件（否则前面的 PASS 没有意义）
try {
	await jiti.import("D:/05p/pi-busy-bar/tmp-bad-control.ts");
	console.log("CONTROL: 坏文件竟然加载成功了 —— 探测链路无效");
	process.exit(1);
} catch (err) {
	console.log("CONTROL rejected as expected:", String(err.message).split("\n")[0].slice(0, 90));
}
