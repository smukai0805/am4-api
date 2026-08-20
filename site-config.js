(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AM4SiteConfig = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function resolveApiBase(hostname) {
    return ["127.0.0.1", "localhost", ""].includes(String(hostname || ""))
      ? "https://am4-api.vercel.app/api"
      : "/api";
  }

  return { resolveApiBase };
});
