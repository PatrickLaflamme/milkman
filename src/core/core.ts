import { glob } from "glob";
import { load } from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import axios, { AxiosRequestConfig, Method } from "axios";
import { createSchedule } from "./schedule";
import { newScriptingConsole, tester } from "./scripting";
import { templateRequest, templateString } from "./templating";
import { duplicates } from "./utils";

/**
 * find names of all resources
 * @param root directory to begin search
 * @returns array of names
 */
export const discoverNames = function (
  root: string,
  environment: string
): string[] {
  const paths = createSchedule(discoverMilk(root, environment)).map(
    (res) => `${res.metadata.name}`
  );
  return paths;
};

export type MilkMetadata = {
  name: string;
  path: string;
  labels: {
    environment?: string;
    [key: string]: string | undefined;
  };
};

export type MilkResource = {
  apiVersion: "milk/alphav1";
  metadata: MilkMetadata;
  kind: "Request" | "Script";
  spec: RequestSpec | ScriptSpec;
};

export type ScriptSpec = {
  dependsOn: string[];
  script: string;
};

export type RequestSpec = {
  scheme: "http" | "https";
  host: string;
  route: string;
  method: "GET" | "POST";
  headers: Record<string, string | number | boolean>;
  body: string;
  dependsOn: string[];
};

/**
 * find paths for all discovered resources
 * @param root directory to begin search
 * @returns
 */
export const discoverResources = function (root: string): string[] {
  const p = path.resolve(root);
  const pattern = `${p}/**/*.yml`;
  return glob.sync(pattern);
};

export const discoverMilk = function (
  root: string,
  environment: string
): MilkResource[] {
  const all = discoverResources(root)
    .map((path) => {
      return parseYamlResource(path);
    })
    .filter((resource) => {
      const { environment: e = "" } = resource?.metadata?.labels;
      return e == "" || environment == "" || e == environment;
    });
  const dupes = duplicates(all.map((r) => r.metadata.name));
  if (dupes.length > 0) {
    throw new Error(`You have duplicate resources names=${dupes}`);
  }
  return all;
};

const parseYamlResource = function (path: string): MilkResource {
  const data = fs.readFileSync(path, "utf8");
  const resource = load(data) as MilkResource;

  if (!resource.apiVersion) {
    throw new Error(`${path} does not have apiVersion defined`);
  }
  if (!resource.metadata.name) {
    throw new Error(`${path} does not have metadata.name defined`);
  }
  if (!resource.kind) {
    throw new Error(`${path} does not have kind defined`);
  }

  resource.metadata.labels = resource.metadata.labels || new Map<string, any>();
  resource.metadata.path = path;
  return resource;
};

export const execute = async function (
  resources: MilkResource[]
): Promise<Map<String, any>> {
  const m = new Map<string, any>();
  await executeWithContext(resources, m);
  return m;
};

const executeWithContext = function (
  resources: MilkResource[],
  context: Map<string, any>
): Promise<any> {
  const asyncs: CallableFunction[] = createSchedule(resources).map(
    (resource) => {
      switch (resource.kind) {
        case "Request":
          return async () => {
            return executeRequest(resource, context);
          };
        case "Script":
          return async () => {
            executeScript(resource, context);
          };
      }
    }
  );
  return asyncs.reduce(
    (promise, func) => promise.then(() => func()),
    Promise.resolve()
  );
};

export const executeScript = function (
  resource: MilkResource,
  context: Map<string, any>
): Promise<any> {
  const spec = resource.spec as ScriptSpec;
  const templated = templateString(spec.script, Object.fromEntries(context));
  const userScript = Function("context", "console", "test", templated);
  const thisConsole = newScriptingConsole(resource);
  try {
    userScript(context, thisConsole, tester(thisConsole));
  } catch (error) {
    thisConsole.error(`Error while executing script error=${error}`);
  }
  return Promise.resolve(true);
};

export const executeRequest = async function (
  resource: MilkResource,
  context: Map<string, any>
): Promise<any> {
  const thisConsole = newScriptingConsole(resource);
  const spec = resource.spec as RequestSpec;
  const uri = templateString(
    `${spec.scheme}://${spec.host}${spec.route}`,
    Object.fromEntries(context)
  );

  const options: AxiosRequestConfig = templateRequest(
    {
      method: spec.method,
      headers: spec.headers,
      url: uri,
      data: spec.body,
    },
    Object.fromEntries(context)
  );
  return axios.request(options).then((response) => {
    thisConsole.log(`${options.method} ${options.url} ${response.status}`);
    context.set(resource.metadata.name, {
      response: response,
      status: response.status,
    });
  });
};
