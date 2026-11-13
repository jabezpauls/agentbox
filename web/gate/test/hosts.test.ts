import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { classifyHost, hostNames, hostOf } from "../src/hosts.js";

const ON = {
  AGENTBOX_PUBLIC_URL: "https://work.example.com",
  AGENTBOX_MACHINES_HOST: "machines.example.com",
  AGENTBOX_MACHINE_APPS_HOST: "mapps.example.com",
};

describe("the machines hostnames in the configuration", () => {
  it("are off unless both are set", () => {
    const c = loadConfig({ AGENTBOX_PUBLIC_URL: "https://work.example.com" });
    expect(c.machinesHost).toBeNull();
    expect(c.machineAppsHost).toBeNull();
    expect(hostNames(c)).toBeNull();
    // Set empty, as compose passes an unset key.
    expect(hostNames(loadConfig({ ...ON, AGENTBOX_MACHINES_HOST: "", AGENTBOX_MACHINE_APPS_HOST: "" }))).toBeNull();
  });

  it("are both or neither", () => {
    expect(() => loadConfig({ ...ON, AGENTBOX_MACHINE_APPS_HOST: "" })).toThrow(/both/);
    expect(() => loadConfig({ ...ON, AGENTBOX_MACHINES_HOST: "" })).toThrow(/both/);
  });

  it("are read in lower case, and must be plain hostnames distinct from the box's", () => {
    const c = loadConfig({ ...ON, AGENTBOX_MACHINES_HOST: "Machines.Example.COM" });
    expect(hostNames(c)).toEqual({ main: "work.example.com", machines: "machines.example.com", machineApps: "mapps.example.com" });
    for (const bad of ["localhost", "10.0.0.1", "machines.example.com:8443", "https://machines.example.com", "a b.example.com", "work.example.com", "mapps.example.com"]) {
      expect(() => loadConfig({ ...ON, AGENTBOX_MACHINES_HOST: bad }), bad).toThrow();
    }
  });

  it("need the box's own public https hostname", () => {
    for (const url of ["", "http://work.example.com", "https://localhost", "https://127.0.0.1", "https://work.example.com:8443"]) {
      expect(() => loadConfig({ ...ON, AGENTBOX_PUBLIC_URL: url }), url).toThrow(/AGENTBOX_PUBLIC_URL/);
    }
  });
});

describe("classifyHost", () => {
  const names = hostNames(loadConfig(ON));

  it("names exactly the three configured hosts", () => {
    expect(classifyHost("work.example.com", names)).toBe("main");
    expect(classifyHost("machines.example.com", names)).toBe("machines");
    expect(classifyHost("mapps.example.com", names)).toBe("machine-apps");
    // Case, a port and the root's trailing dot do not make another host.
    expect(classifyHost("MACHINES.example.com:443", names)).toBe("machines");
    expect(classifyHost("work.example.com.", names)).toBe("main");
  });

  it("refuses every other host (the caller answers 421)", () => {
    for (const h of [undefined, "", "gate:7900", "127.0.0.1:7900", "localhost", "example.com", "x.machines.example.com", "machines.example.com.evil", "[::1]:7900", "machines.example.com@evil", "work.example.com, machines.example.com"]) {
      expect(classifyHost(h, names), String(h)).toBeNull();
    }
  });

  it("calls every host the main one while the feature is off, as before", () => {
    for (const h of [undefined, "", "gate:7900", "127.0.0.1:7900", "machines.example.com", "anything"]) {
      expect(classifyHost(h, null)).toBe("main");
    }
  });

  it("reads a Host header as its hostname", () => {
    expect(hostOf("Example.COM:8080")).toBe("example.com");
    expect(hostOf("[::1]:80")).toBe("[::1]");
    expect(hostOf("a/b")).toBeNull();
  });
});
