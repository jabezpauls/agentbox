import { afterAll } from "vitest";
import { removeTmpDirs } from "./helpers.js";

// Every temporary folder a test file made goes when the file is done.
afterAll(() => removeTmpDirs());
