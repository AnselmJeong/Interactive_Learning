import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json";

export default {
  app: {
    name: "Learnie",
    identifier: "dev.aquatope.learnie",
    version: pkg.version,
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      main: {
        entrypoint: "src/views/main/index.tsx",
      },
    },
    copy: {
      "src/views/main/index.html": "views/main/index.html",
      "src/views/main/styles/app.css": "views/main/app.css",
      "assets/app-icon.svg": "views/main/assets/app-icon.svg",
      "buddy/botan-kamiina-sharpened.webp": "views/main/assets/botan-kamiina-sharpened.webp",
      "buddy/milestones/milestone-30.gif": "views/main/assets/buddy-milestone-30.gif",
      "buddy/milestones/milestone-50.gif": "views/main/assets/buddy-milestone-50.gif",
      "buddy/milestones/milestone-85.gif": "views/main/assets/buddy-milestone-85.gif",
      "buddy/milestones/milestone-100.gif": "views/main/assets/buddy-milestone-100.gif",
      "node_modules/katex/dist/katex.min.css": "views/main/katex.min.css",
      "node_modules/chart.js/dist/chart.umd.js": "external-html-dependencies/chart.js-4.4.1.umd.js",
      "node_modules/chart.js/LICENSE.md": "external-html-dependencies/chart.js-4.4.1-LICENSE.md",
      "python/pyproject.toml": "python/pyproject.toml",
      "python/uv.lock": "python/uv.lock",
      "python/src": "python/src",
      "python/.bundle": "python/.bundle",
    },
    mac: {
      bundleCEF: false,
      defaultRenderer: "native",
      icons: "assets/app-icon.iconset",
      codesign: false,
      notarize: false,
    },
    win: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "assets/app-icon.iconset/icon_256x256.png",
    },
  },
} satisfies ElectrobunConfig;
