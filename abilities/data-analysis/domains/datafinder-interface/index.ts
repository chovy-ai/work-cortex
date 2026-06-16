/**
 * DataFinder OpenAPI module.
 *
 * Public interface:
 *     import {
 *       DataFinderClient, DataFinderConfig, APIResult,
 *       EndpointNotFound, loadManifest, loadConfigFromEnv,
 *     } from "./index.js";
 *
 * The complete, machine-readable interface surface lives in manifest.json.
 * Use DataFinderClient.listEndpoints() / .describe(id) to discover it,
 * and .call(id, params) or the typed wrappers to invoke it.
 *
 * When an endpoint is missing, see UPDATE.md to extend the manifest from the
 * latest official docs.
 */

export {
  DataFinderClient,
  EndpointNotFound,
  loadConfigFromEnv,
  loadManifest,
  type APIResult,
  type DataFinderConfig,
  type Manifest,
  type ManifestEndpoint,
} from "./client.js";
