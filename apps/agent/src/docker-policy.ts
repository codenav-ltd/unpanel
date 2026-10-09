// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { DockerError } from "./docker-error.ts";

/** Shared by Compose and container recreation; never resubmit arbitrary host configuration. */
export function assertDockerConfig(config: Record<string, unknown>): void {
  const host = config["HostConfig"] as Record<string, unknown> | undefined;
  if (!host)
    throw new DockerError("E_POLICY_DENIED", "The container has no usable host configuration.");
  const denied =
    host["Privileged"] ||
    host["PidMode"] === "host" ||
    host["IpcMode"] === "host" ||
    host["UTSMode"] === "host" ||
    host["UsernsMode"] === "host" ||
    host["NetworkMode"] === "host" ||
    String(host["NetworkMode"] ?? "").startsWith("container:") ||
    (Array.isArray(host["CapAdd"]) && host["CapAdd"].length) ||
    (Array.isArray(host["Devices"]) && host["Devices"].length) ||
    (Array.isArray(host["DeviceRequests"]) && host["DeviceRequests"].length) ||
    (Array.isArray(host["SecurityOpt"]) && host["SecurityOpt"].length) ||
    (Array.isArray(host["VolumesFrom"]) && host["VolumesFrom"].length) ||
    host["CgroupParent"] ||
    host["CgroupnsMode"] === "host";
  if (denied)
    throw new DockerError(
      "E_POLICY_DENIED",
      "This container uses host privileges or namespaces. Manage its recreation from the server terminal.",
    );
  for (const mount of (host["Mounts"] as Record<string, unknown>[] | undefined) ?? [])
    if (mount["Type"] !== "volume" || mount["VolumeOptions"])
      throw new DockerError(
        "E_POLICY_DENIED",
        "Recreation only supports ordinary named-volume mounts. Host mounts must be managed from the server terminal.",
      );
  for (const bind of (host["Binds"] as string[] | undefined) ?? [])
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*:\//.test(bind))
      throw new DockerError(
        "E_POLICY_DENIED",
        "Host bind mounts must be managed from the server terminal.",
      );
}

export function assertComposeConfig(config: Record<string, unknown>): void {
  if (config["include"] || config["configs"] || config["secrets"])
    throw new DockerError(
      "E_POLICY_DENIED",
      "Included files, configs and secrets must be managed from the server terminal.",
    );
  for (const volume of Object.values(
    (config["volumes"] as Record<string, Record<string, unknown>>) ?? {},
  ))
    if (volume["driver_opts"] || (volume["driver"] && volume["driver"] !== "local"))
      throw new DockerError(
        "E_POLICY_DENIED",
        "Use ordinary named volumes without custom drivers or driver options.",
      );
  for (const network of Object.values(
    (config["networks"] as Record<string, Record<string, unknown>>) ?? {},
  ))
    if (network["name"] === "host" || network["driver"] === "host" || network["driver_opts"])
      throw new DockerError(
        "E_POLICY_DENIED",
        "Host networks and custom driver options are not supported.",
      );
  const services = config["services"] as Record<string, Record<string, unknown>> | undefined;
  if (!services || !Object.keys(services).length || Object.keys(services).length > 100)
    throw new DockerError("E_INVALID_PARAMS", "Define between 1 and 100 services.");
  for (const service of Object.values(services)) {
    if (
      !service["image"] ||
      service["build"] ||
      service["env_file"] ||
      service["extends"] ||
      service["devices"] ||
      service["device_cgroup_rules"] ||
      service["cap_add"] ||
      service["security_opt"] ||
      service["volumes_from"] ||
      service["configs"] ||
      service["secrets"] ||
      service["cgroup_parent"] ||
      service["cgroup"] === "host" ||
      service["privileged"] ||
      service["pid"] === "host" ||
      service["ipc"] === "host" ||
      service["uts"] === "host" ||
      service["userns_mode"] === "host" ||
      service["network_mode"] ||
      service["post_start"] ||
      service["pre_stop"] ||
      JSON.stringify(service["deploy"] ?? {}).includes('"devices"')
    )
      throw new DockerError(
        "E_POLICY_DENIED",
        "Use image-based services without host privileges, external files, device access or lifecycle hooks.",
      );
    for (const volume of (service["volumes"] as Record<string, unknown>[] | undefined) ?? [])
      if (
        volume["type"] !== "volume" ||
        !volume["source"] ||
        Object.keys((volume["volume"] as Record<string, unknown>) ?? {}).some(
          (key) => key !== "nocopy",
        )
      )
        throw new DockerError(
          "E_POLICY_DENIED",
          "Compose stacks must use ordinary named volumes; host bind mounts are not allowed.",
        );
  }
}
