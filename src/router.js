// No framework dependency.
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const segments = pattern.split("/").filter(Boolean);
    this.routes.push({ method, segments, handler });
  }

  match(method, url) {
    const path = url.split("?")[0];
    const parts = path.split("/").filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}
