const RESET = "\x1b[0m";
const ansiSupported = !!Bun.color("red", "ansi");

function wrap(code: string | null) {
  if (!code) return (text: string) => text;
  return (text: string) => `${code}${text}${RESET}`;
}

export const c = {
  red: wrap(Bun.color("red", "ansi")),
  green: wrap(Bun.color("green", "ansi")),
  blue: wrap(Bun.color("blue", "ansi")),
  yellow: wrap(Bun.color("yellow", "ansi")),
  cyan: wrap(Bun.color("cyan", "ansi")),
  dim: wrap(ansiSupported ? "\x1b[2m" : null),
};
