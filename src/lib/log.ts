import pc from "picocolors";

export const log = {
  info: (msg: string) => console.log(pc.blue("info"), msg),
  success: (msg: string) => console.log(pc.green("ok"), msg),
  warn: (msg: string) => console.log(pc.yellow("warn"), msg),
  error: (msg: string) => console.error(pc.red("error"), msg),
  dim: (msg: string) => console.log(pc.dim(msg)),
  line: (msg: string) => console.log(msg),
};
