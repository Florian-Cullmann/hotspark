# Project maintenance

One shared `hotspark-maintenance` service on the proxy network serves an HTTP 503 page and `Retry-After`. Its `/health` endpoint returns 200. It has no project network or database access. Enabling maintenance rewrites only the selected project's dynamic Traefik backend; internal services, other projects and the administration API/UI continue running.

`PUT /api/v1/projects/:id/maintenance` with `{"enabled":true}` queues a typed agent operation. `maintenanceEnabled` stores manual intent; `maintenanceObserved` reports the applied routing state. Disable using the same endpoint with false.

ApplicationSpec `deployment.maintenance` supports:

- `never`: do not automatically enter maintenance during a normal deployment.
- `during-migrations`: enter before structured migration hooks.
- `entire-deployment`: enter before fetching/building.

After success, restore the manual preference. After failure, restore it if the previous release passes health verification. Without a healthy previous release, keep maintenance enabled. Recovery applies the same rule. A later successful deploy restores the manual preference. Manually disabling maintenance without a healthy application may expose an unavailable backend; inspect project health first.
