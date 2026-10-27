const config = Bun.TOML.parse(await Bun.file("bunfig.toml").text()) as { install?: { registry?: string; minimumReleaseAge?: number; security?: unknown } };
if (config.install?.registry !== "https://registry.npmjs.org" || config.install.minimumReleaseAge !== 604800 || config.install.security) throw new Error("Dependency policy differs from the managed platform contract.");
export {};
