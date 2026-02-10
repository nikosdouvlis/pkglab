import { c } from "./color";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export type SpinnerLine = string | { text: string; header: true };

export function createMultiSpinner(lines: SpinnerLine[]) {
  const isTTY = process.stdout.isTTY;
  const entries = lines.map((line) =>
    typeof line === "string"
      ? { text: line, header: false, done: false, failed: false }
      : { text: line.text, header: true, done: false, failed: false },
  );
  let frame = 0;
  let interval: Timer | undefined;
  let rendered = false;

  function render() {
    if (rendered) {
      process.stdout.write(`\x1b[${entries.length}A`);
    }
    for (const entry of entries) {
      if (entry.header) {
        process.stdout.write(`\x1b[2K${entry.text}\n`);
      } else {
        const icon = entry.done
          ? c.green("✔")
          : entry.failed
            ? c.red("✖")
            : c.cyan(FRAMES[frame % FRAMES.length]);
        process.stdout.write(`\x1b[2K  ${icon} ${entry.text}\n`);
      }
    }
    frame++;
    rendered = true;
  }

  return {
    start() {
      if (!isTTY) {
        for (const entry of entries) {
          console.log(entry.header ? entry.text : `  - ${entry.text}`);
        }
        return;
      }
      render();
      interval = setInterval(render, 80);
    },
    complete(index: number) {
      entries[index].done = true;
    },
    fail(index: number) {
      entries[index].failed = true;
    },
    stop() {
      if (interval) clearInterval(interval);
      if (isTTY) render();
    },
  };
}
