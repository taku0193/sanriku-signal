import { readFileSync } from "node:fs";

export const projectRoot = new URL("../../../", import.meta.url);

export function readTextFile(path: string): string {
  return readFileSync(new URL(path, projectRoot), "utf8");
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readTextFile(path)) as T;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
