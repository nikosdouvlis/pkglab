import { c } from "./color";

export const log = {
  info: (msg: string) => console.log(c.blue("info"), msg),
  success: (msg: string) => console.log(c.green("ok"), msg),
  warn: (msg: string) => console.log(c.yellow("warn"), msg),
  error: (msg: string) => console.error(c.red("error"), msg),
  dim: (msg: string) => console.log(c.dim(msg)),
  line: (msg: string) => console.log(msg),
};
