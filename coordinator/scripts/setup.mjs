import { createInterface } from 'node:readline/promises';
import { applySetup, previewSetup } from './workspace/install.mjs';

async function setup() {
  const plan = previewSetup();
  if (plan.error) throw Error(plan.error);
  if (!plan.confirmation) {
    console.log('AgentBoat 的角色 skill 和 hooks 已就绪。');
    return;
  }
  console.log('AgentBoat 将更新以下路径：');
  for (const target of plan.paths) console.log('  ' + target);
  console.log('备份与执行记录：' + plan.backupRoot);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const consent = await prompt.question('输入 yes 继续，直接回车取消：').finally(() => prompt.close());
  if (consent.trim() !== 'yes') {
    console.log('已取消。');
    return;
  }
  const result = applySetup(plan.confirmation);
  console.log('AgentBoat 的角色 skill 和 hooks 已就绪。');
  if (result.backup) console.log('备份与执行记录：' + result.backup);
  console.log('若使用 Codex，请确认 Codex 会话所在 PATH 可运行 Node ≥22，并在 Codex CLI 输入 /hooks，信任 SessionStart、PreToolUse 和 Stop。');
}
await setup().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
