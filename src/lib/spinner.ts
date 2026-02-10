import { c } from "./color";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function createMultiSpinner(lines: string[]) {
  const isTTY = process.stdout.isTTY;
  const done = new Array<boolean>(lines.length).fill(false);
  const failed = new Array<boolean>(lines.length).fill(false);
  let frame = 0;
  let interval: Timer | undefined;
  let rendered = false;

  function render() {
    if (rendered) {
      process.stdout.write(`\x1b[${lines.length}A`);
    }
    for (let i = 0; i < lines.length; i++) {
      const icon = done[i]
        ? c.green("✔")
        : failed[i]
          ? c.red("✖")
          : c.cyan(FRAMES[frame % FRAMES.length]);
      process.stdout.write(`\x1b[2K  ${icon} ${lines[i]}\n`);
    }
    frame++;
    rendered = true;
  }

  return {
    start() {
      if (!isTTY) {
        for (const line of lines) console.log(`  - ${line}`);
        return;
      }
      render();
      interval = setInterval(render, 80);
    },
    complete(index: number) {
      done[index] = true;
    },
    fail(index: number) {
      failed[index] = true;
    },
    stop() {
      if (interval) clearInterval(interval);
      if (isTTY) render();
    },
  };
}
