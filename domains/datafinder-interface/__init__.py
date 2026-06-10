"""
DataFinder OpenAPI module.

Public interface:
    from datafinder import (
        DataFinderClient, DataFinderConfig, APIResult,
        EndpointNotFound, load_manifest, load_config_from_env,
    )

The complete, machine-readable interface surface lives in manifest.json.
Use DataFinderClient.list_endpoints() / .describe(id) to discover it,
and .call(id, params) or the typed wrappers to invoke it.

When an endpoint is missing, see UPDATE.md to extend the manifest from the
latest official docs.
"""

from .client import (
    APIResult,
    DataFinderClient,
    DataFinderConfig,
    EndpointNotFound,
    load_config_from_env,
    load_manifest,
)

__all__ = [
    "APIResult",
    "DataFinderClient",
    "DataFinderConfig",
    "EndpointNotFound",
    "load_config_from_env",
    "load_manifest",
]
