# Linux Metric Collection: Fields and Formulas

> Applies to: `apps/agent/src/collector/`. Verification markers: see [README](./README.md).
> References: [proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html), kernel docs [iostats](https://docs.kernel.org/admin-guide/iostats.html)

## 1. CPU: `/proc/stat` ✅

```
cpu  4705 356 584 3699176 23060 0 277 0 0 0
cpu0 1393 280 284 925327 6087 0 135 0 0 0
```

Fields (in USER_HZ ticks, usually 1/100 s): `user nice system idle iowait irq softirq steal guest guest_nice`.

```ts
// guest / guest_nice are already included in user / nice; do not add them again
const total = user + nice + system + idle + iowait + irq + softirq + steal;
const idleAll = idle + iowait;
cpuPct = (Δtotal - ΔidleAll) / Δtotal * 100;
iowaitPct = Δiowait / Δtotal * 100;
stealPct  = Δsteal  / Δtotal * 100;
```

Pitfalls:

- On some kernels a single CPU's `iowait` counter can **decrease**. Clamp negative deltas to 0.
- With CPU hotplug or VM core changes, the number of `cpuN` lines changes. Align the per-core array by name, not by index.
- **steal** is time the VM wanted to run but the hypervisor scheduled another guest. Persistently high steal on a VPS usually means the host is oversubscribed.

## 2. Memory: `/proc/meminfo` ✅

```ts
used = MemTotal - MemAvailable;      // MemAvailable exists since kernel 3.14
swapUsed = SwapTotal - SwapFree;
```

Old kernels without `MemAvailable`: `available ≈ MemFree + Buffers + Cached + SReclaimable - Shmem`.

Values are in kB (really KiB); multiply by 1024.

## 3. Load and processes: `/proc/loadavg` ✅

```
0.12 0.08 0.05 2/345 67890
```

1/5/15-minute load, `runnable scheduling entities/total`, last allocated PID. Load alerts should divide by the core count (`load1_per_core`).

## 4. Network: `/proc/net/dev` ✅

```
 Inter-|   Receive                                                |  Transmit
  face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 123456789  98765   0    0    0     0          0         0  987654321  87654    0    0    0     0       0          0
```

After the colon, split on whitespace: index 0 = rx bytes, 1 = rx packets, 2 = rx errors, 8 = tx bytes, 9 = tx packets, 10 = tx errors. There may be no space between the interface name and the first number (`eth0:123`), so split on the colon.

**Physical NIC detection**: `/sys/class/net/<if>/device` exists for physical NICs (including virtio and xen); virtual ones live under `/sys/devices/virtual/net/`. Exception: OpenVZ's `venet0` is virtual but carries the real traffic and needs special handling.

Counters reset on reboot and can wrap on 32-bit systems; handling is described in [modules/monitoring.md](../modules/monitoring.md) §6.2.

## 5. Disk IO: `/proc/diskstats` ✅

```
   8       0 sda 12345 678 901234 5678 23456 789 1234567 8901 0 4567 14579 ...
```

Counting from column 1: 1 major, 2 minor, 3 device name, 4 reads completed, 6 sectors read, 8 writes completed, 10 sectors written, 13 time spent doing IO (ms). Kernel 4.18 appended discard fields and 5.5 appended flush fields, so **read only the first 14 columns by position**.

- Sector size in diskstats is **always 512 bytes**, regardless of the device's real sector size.
- Count whole disks only to avoid double counting: devices in `/sys/block/*` that have a `device` link (`sda`, `vda`, `nvme0n1`, `xvda`); skip `loop*`, `ram*`, `dm-*`, `md*`, `zram*`.
- Busy% can be approximated as `Δ(column 13) / Δtime(ms) × 100`.

## 6. Filesystem capacity ✅

Mount points come from `/proc/self/mountinfo`: field 5 is the mount point; after the ` - ` separator come the filesystem type and the mount source. Spaces and similar characters in mount points are octal-escaped (`\040`) and must be decoded.

Capacity via Node's `fs.statfs(path, { bigint: true })`:

```ts
used = (blocks - bfree) * bsize;
usePct = used / (used + bavail) * 100;   // matches df's Use%: root-reserved blocks excluded
inodePct = (files - ffree) / files * 100;
```

`statfs` **blocks** when a network filesystem such as NFS is unreachable. Wrap network filesystems in a timeout and keep them off the sampling hot path.

## 7. Sockets: `/proc/net/sockstat`, `sockstat6` ✅

```
TCP: inuse 25 orphan 0 tw 4 alloc 30 mem 3
UDP: inuse 6 mem 4
```

`inuse` includes listening sockets. Counting ESTABLISHED connections precisely requires parsing column 4 of `/proc/net/tcp{,6}` (state `01`), which is expensive with many connections; do it only in on-demand methods.

## 8. Uptime: `/proc/uptime` ✅

The first field is seconds since boot (float).

## 9. Temperatures (optional) ✅

`/sys/class/hwmon/hwmon*/temp*_input`, in millidegrees Celsius; names in the sibling `name` and `temp*_label` files. Usually absent on VPSes.

## 10. Containerized environments ⚠️

Detect with `systemd-detect-virt` (virtualization type) and `systemd-detect-virt -c` (container type):

| Environment | Problem | Handling |
|---|---|---|
| LXC (without lxcfs) | `/proc/meminfo` and `/proc/stat` show the host's data | Read cgroups: `/sys/fs/cgroup/memory.max`, `memory.current`, `cpu.max`, `cpu.stat` |
| LXC (with lxcfs) | `/proc` is virtualized | Read normally |
| OpenVZ 7 | NIC is `venet0`; steal in `/proc/stat` may be inaccurate | Count `venet0` toward traffic |
| Agent inside Docker | Not supported | The installer detects it and refuses |

## 11. cgroup version detection ✅

`/sys/fs/cgroup/cgroup.controllers` exists → cgroup v2 (unified hierarchy); otherwise v1 or hybrid.

## 12. Performance notes

- Each sampling cycle reads 5–8 small files. Avoid `open`/`close` every time: keep file descriptors for hot files and `fs.read` from position 0.
- Never walk `/proc/[pid]` during regular sampling; only in the on-demand "processes" method.
- Parsers are pure functions taking text input, so they can be tested with fixtures ([design/10](../design/10-testing.md) §2).
