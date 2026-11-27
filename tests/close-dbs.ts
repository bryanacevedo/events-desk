/* Runs before every test file (vite.config.ts setupFiles): closes the databases a test opened once the test is over. See tests/helpers.ts. */
import { afterEach, beforeEach } from "vitest";
import { testEnds, testStarts } from "./helpers.ts";

beforeEach(testStarts);
afterEach(testEnds);
