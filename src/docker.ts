import type { Host, OnLine } from "./host.js";

// The docker CLI on the deploy host. Every guard here reads a single snapshot
// rather than inspecting one object at a time, because a round trip to another
// machine costs more than the command it carries.

export type BuildInvocation = {
  // A directory on the host, which is where the checkout already is
  context: string;
  // Rendered per app and kept outside the context, so a repository's own
  // Dockerfile and .dockerignore are neither read nor overwritten
  dockerfile: string;
  // The moving name the container refers to, and the versioned one the next
  // deploy recognises
  tags: string[];
  // Secret id to a path on the host holding its contents
  secrets?: Record<string, string>;
  // Stops at the builder stage, for the image a before-swap step runs in
  target?: string;
};

const RUNNING = new Set(["running", "restarting"]);

// One command in place of an inspect per object. Every guard in this file used
// to be its own round trip, and a round trip here is a container exec
const SNAPSHOT = [
  "ps -a --format '{{.Names}}\t{{.State}}'",
  "docker image ls --format '{{.Repository}}:{{.Tag}}'",
  "docker network ls --format '{{.Name}}'",
].join("; echo --- ; ");

type HostState = {
  containers: Map<string, string>;
  images: Set<string>;
  networks: Set<string>;
};

export class Docker {
  readonly network: DockerNetwork;
  readonly image: DockerImage;
  readonly container: DockerContainer;

  // The promise, not the state. Two builds and the infrastructure step all ask
  // for this at once, and caching the result alone lets every one of them miss
  private state?: Promise<HostState>;

  constructor(private readonly host: Host) {
    this.network = new DockerNetwork(this);
    this.image = new DockerImage(this);
    this.container = new DockerContainer(this);
  }

  // Read once, then kept current by the mutations below. A deploy owns the
  // host for its duration, so nothing else is moving underneath it
  async snapshot() {
    this.state ??= this.read();
    return await this.state;
  }

  private async read(): Promise<HostState> {
    const { stdout } = await this.run(SNAPSHOT);
    const [containers = "", images = "", networks = ""] = stdout.split("---");

    return {
      containers: new Map(
        lines(containers).map((line) => {
          const [name = "", status = "unknown"] = line.split("\t");
          return [name, status];
        }),
      ),
      // Both spellings, so a lookup by bare name and one by name:tag both hit
      images: new Set(
        lines(images).flatMap((line) => [line, line.replace(/:latest$/, "")]),
      ),
      networks: new Set(lines(networks)),
    };
  }

  async run(command: string, onLine?: OnLine) {
    return await this.host.sh(`docker ${command}`, onLine);
  }

  // Called by every mutation, so the snapshot never goes stale
  async track(change: (state: HostState) => void) {
    change(await this.snapshot());
  }

  async runOrThrow(command: string, message: string, onLine?: OnLine) {
    const result = await this.run(command, onLine);
    if (result.code === 0) return result;

    throw new Error(`${message}: ${result.stderr || result.stdout}`);
  }
}

class DockerNetwork {
  constructor(private readonly docker: Docker) {}

  async exists(name: string) {
    return (await this.docker.snapshot()).networks.has(name);
  }

  async create(name: string, subnet?: string) {
    if (await this.exists(name)) return false;

    const suffix = subnet ? ` --subnet=${subnet}` : "";
    await this.docker.runOrThrow(
      `network create ${name}${suffix}`,
      "Network creation failed",
    );

    await this.docker.track((state) => state.networks.add(name));
    return true;
  }

  async remove(name: string) {
    if (!(await this.exists(name))) return false;

    await this.docker.runOrThrow(`network rm ${name}`, "Network removal failed");
    await this.docker.track((state) => state.networks.delete(name));
    return true;
  }

  // Disconnect can fail because the container was never attached, which is not
  // an error. Connect failing is, the address is what nginx resolves to
  async reconnect(network: string, container: string, ip: string) {
    if (!(await this.docker.container.exists(container))) return false;

    await this.docker.run(`network disconnect ${network} ${container}`);
    await this.docker.runOrThrow(
      `network connect --ip ${ip} ${network} ${container}`,
      "Network connect failed",
    );

    return true;
  }
}

class DockerImage {
  constructor(private readonly docker: Docker) {}

  async exists(name: string) {
    return (await this.docker.snapshot()).images.has(name);
  }

  // Every version of one image the host is holding. A deploy tags what it built
  // by release, and without this the previous ones are never reclaimed.
  // :latest is not one of them: it is the moving name a container is created
  // from, and reclaiming it leaves the host unable to start the app
  async versionsOf(repository: string) {
    const images = (await this.docker.snapshot()).images;

    return [...images].filter(
      (name) => name.startsWith(`${repository}:`) && name !== `${repository}:latest`,
    );
  }

  // BuildKit is already inside the daemon that will run the container, so the
  // image it produces never has to be serialised, transferred or loaded
  async build(spec: BuildInvocation, onLine?: OnLine) {
    const command = [
      "build",
      // Provenance attestations make the result a manifest list, which is a
      // different thing to tag and nothing here consumes them
      "--progress plain --provenance=false --pull",
      `-f ${spec.dockerfile}`,
      ...spec.tags.map((tag) => `-t ${tag}`),
      ...Object.entries(spec.secrets ?? {}).map(
        ([id, path]) => `--secret id=${id},src=${path}`,
      ),
      ...(spec.target ? [`--target ${spec.target}`] : []),
      spec.context,
    ].join(" ");

    await this.docker.runOrThrow(command, "Image build failed", onLine);
    await this.docker.track((state) => {
      for (const tag of spec.tags) state.images.add(tag);
    });

    return true;
  }

  // A second name for an image that is already local. Costs nothing, and it is
  // what lets the next deploy recognise a commit it already holds
  async retag(from: string, to: string) {
    await this.docker.runOrThrow(`tag ${from} ${to}`, "Image tagging failed");
    await this.docker.track((state) => state.images.add(to));
    return true;
  }

  async remove(name: string) {
    if (!(await this.exists(name))) return false;

    await this.docker.runOrThrow(
      `image remove -f ${name}`,
      "Image removal failed",
    );

    await this.docker.track((state) => state.images.delete(name));
    return true;
  }
}

class DockerContainer {
  constructor(private readonly docker: Docker) {}

  async exists(name: string) {
    return (await this.docker.snapshot()).containers.has(name);
  }

  async status(name: string) {
    return (await this.docker.snapshot()).containers.get(name) ?? "none";
  }

  async isRunning(name: string) {
    return RUNNING.has(await this.status(name));
  }

  async start(name: string) {
    if (!(await this.exists(name))) {
      throw new Error(`Cannot start ${name}, it does not exist`);
    }

    await this.docker.runOrThrow(
      `container start ${name}`,
      "Container start failed",
    );

    await this.docker.track((state) => state.containers.set(name, "running"));
    return true;
  }

  async stop(name: string) {
    if (!(await this.exists(name))) return false;

    await this.docker.runOrThrow(
      `container stop ${name}`,
      "Container stop failed",
    );

    await this.docker.track((state) => state.containers.set(name, "exited"));
    return true;
  }

  // Refuses rather than clobbers, a rename onto an existing name would lose
  // whichever container is already there
  async rename(from: string, to: string) {
    if (!(await this.exists(from))) return false;
    if (await this.exists(to)) return false;

    await this.docker.runOrThrow(
      `container rename ${from} ${to}`,
      "Container rename failed",
    );

    await this.docker.track((state) => {
      const status = state.containers.get(from) ?? "unknown";
      state.containers.delete(from);
      state.containers.set(to, status);
    });

    return true;
  }

  async remove(name: string) {
    if (!(await this.exists(name))) return false;
    if (await this.isRunning(name)) {
      throw new Error(`Cannot remove ${name} while it is running`);
    }

    await this.docker.runOrThrow(
      `container rm ${name}`,
      "Container removal failed",
    );

    await this.docker.track((state) => state.containers.delete(name));
    return true;
  }

  async create(builder: DockerBuilder) {
    await this.docker.runOrThrow(builder.parse(), "Container create failed");
    await this.docker.track((state) => state.containers.set(builder.named(), "created"));
    return true;
  }

  builder() {
    return new DockerBuilder(this);
  }
}

function lines(block: string) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export class DockerBuilder {
  private _name = "";
  private _image = "";
  private _hostname?: string;
  private _ip?: string;
  private _restart?: string;
  private readonly _networks: string[] = [];
  private readonly _volumes: string[] = [];
  private readonly _hosts: string[] = [];
  private readonly _ports: string[] = [];
  private readonly _env: string[] = [];
  private _envFile?: string;

  constructor(private readonly container: DockerContainer) {}

  name(value: string) {
    this._name = value;
    return this;
  }

  image(value: string) {
    this._image = value;
    return this;
  }

  hostname(value: string) {
    this._hostname = value;
    return this;
  }

  network(value: string) {
    this._networks.push(value);
    return this;
  }

  volume(from: string, to: string) {
    this._volumes.push(`${from}:${to}`);
    return this;
  }

  extraHost(name: string, ip: string) {
    this._hosts.push(`${name}:${ip}`);
    return this;
  }

  restart(value: string) {
    this._restart = value;
    return this;
  }

  ip(value: string) {
    this._ip = value;
    return this;
  }

  env(name: string, value: string) {
    this._env.push(`${name}=${value}`);
    return this;
  }

  // A path on the host rather than the values themselves, so a password is
  // never an argument in the process list or in the shell history
  envFile(path: string) {
    this._envFile = path;
    return this;
  }

  port(from: number, to: number) {
    this._ports.push(`${from}:${to}`);
    return this;
  }

  named() {
    return this._name;
  }

  parse() {
    if (!this._name) throw new Error("A container needs a name");
    if (!this._image) throw new Error(`${this._name} has no image`);

    // Defaults to the container name. The original emitted "--hostname
    // undefined", because nothing ever called the setter
    const hostname = this._hostname ?? this._name;

    return [
      `container create --name ${this._name} --hostname ${hostname}`,
      ...this._volumes.map((volume) => `-v ${volume}`),
      ...this._networks.map((network) => `--network ${network}`),
      ...this._ports.map((port) => `-p ${port}`),
      ...this._hosts.map((host) => `--add-host ${host}`),
      ...(this._envFile ? [`--env-file ${this._envFile}`] : []),
      ...this._env.map((entry) => `-e ${entry}`),
      ...(this._ip ? [`--ip ${this._ip}`] : []),
      ...(this._restart ? [`--restart ${this._restart}`] : []),
      this._image,
    ].join(" ");
  }

  async create() {
    return await this.container.create(this);
  }
}
