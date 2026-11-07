import { knipConfig } from "@burdenoff/toolchain/knip/base";

export default knipConfig({
  entry: ["src/index.ts"],
  project: ["src/**/*.ts"],
});
