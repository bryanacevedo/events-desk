import { describe, expect, it } from "vitest";
import { simGuard } from "../src/server/simguard.ts";

const on = { SIM_DB_GUARD: "1", SIM_ALLOWED_HOSTS: "ep-a.c-15.us-east-1.aws.neon.tech", SIM_DB_PREFIX: "sim_" };

describe("simulation database guard", () => {
  it("is off unless asked: any URL passes", () => {
    expect(() => simGuard("postgres://u@prod.example.com/events", {})).not.toThrow();
  });
  it("allows the simulation project's own and prefixed databases", () => {
    expect(() => simGuard("postgres://u:p@ep-a.c-15.us-east-1.aws.neon.tech/neondb?sslmode=require", on)).not.toThrow();
    expect(() => simGuard("postgres://u:p@ep-a.c-15.us-east-1.aws.neon.tech/sim_events", on)).not.toThrow();
  });
  it("refuses another host, another database name, and a local database of the wrong name", () => {
    expect(() => simGuard("postgres://u:p@ep-b.c-15.us-east-1.aws.neon.tech/neondb", on)).toThrow(/refusing host/);
    expect(() => simGuard("postgres://u:p@ep-a.c-15.us-east-1.aws.neon.tech/production", on)).toThrow(/refusing database/);
    expect(() => simGuard("postgres://u@127.0.0.1:5432/customers", on)).toThrow(/refusing local/);
    expect(() => simGuard("postgres://u@127.0.0.1:54329/p3_events", on)).not.toThrow();
  });
  it("refuses URLs the driver would read differently, and lookalike local names", () => {
    for (const u of ["postgres://a@prod.example.com,x@127.0.0.1/p3_events", "postgres://u@127.0.0.1/p3_x?host=prod.example.com", "postgres://u@127.0.0.1/p3_x?database=prod",
      "postgres://u@127.0.0.1/eventsprod", "postgres://u@127.0.0.1/p3_x?options=-c%20y"]) expect(() => simGuard(u, on), u).toThrow();
    expect(() => simGuard("postgres://u@127.0.0.1/p3_events", { ...on, PGHOST: "prod.example.com" })).toThrow(/PG\*/);
  });
});
