"""Where a site's release targets are read: host-config first, then beside the script.

The same rule as gui/server/config/host-config.mjs (docs/host-config.md):
DEVPANEL_HOST_CONFIG_DIR, relative to the config root when relative; when
unset, <config root>/host-config if it exists, else <data root>/host-config if
that exists (only when DEVPANEL_DATA_ROOT is set), else <config root>/host-config. The config root is DEVPANEL_CONFIG_ROOT,
else this checkout. An empty value is unset. Releases started by the engine get
the resolved absolute directory in their environment; this resolves it only when
a procedure is run by hand.
"""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def host_config_dir(env, here=HERE):
    root = Path(env.get('DEVPANEL_CONFIG_ROOT') or here.parent.parent)
    if env.get('DEVPANEL_HOST_CONFIG_DIR'):
        return root / env['DEVPANEL_HOST_CONFIG_DIR']
    in_tree = root / 'host-config'
    if in_tree.is_dir():
        return in_tree
    data = env.get('DEVPANEL_DATA_ROOT')
    if data and (Path(data) / 'host-config').is_dir():
        return Path(data).resolve() / 'host-config'
    return in_tree


def targets_file(site, env, here=HERE):
    name = f'{site}-targets.json'
    for candidate in (host_config_dir(env, here) / 'releases' / name, here / name):
        if candidate.is_file():
            return candidate
    raise ValueError(f'No release targets: neither {host_config_dir(env, here) / "releases" / name} nor {here / name} exists')
