import pkg from "../../package.json";

export const APP_INFO = {
  name: "Learnie",
  version: pkg.version,
  tagline: "Source-Grounded Tutoring System",
  developer: "Developed by Anselm Jeong",
  iconPath: "assets/app-icon.svg",
} as const;
