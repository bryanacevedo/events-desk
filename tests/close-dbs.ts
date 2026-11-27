/* Runs before every test file (vite.config.ts setupFiles): closes the databases a test opened once the test is over. See tests/helpers.ts. Relies on vitest's default sequence.hooks "stack" (afterEach hooks run in reverse, so this one runs after a file's own). A background task the app started and does not await (the sequencer hook after a webhook) can still be running when its database closes: it logs "PGlite is closed" through the app's own catch and nothing fails. */
import { afterEach, beforeEach } from "vitest";
import { testEnds, testStarts } from "./helpers.ts";

beforeEach(testStarts);
afterEach(testEnds);
