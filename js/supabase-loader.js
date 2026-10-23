(() => {
  "use strict";

  // Pinned Supabase JS build.
  // - Vercel / HTTPS: jsDelivr pinned build
  // - Internal media server / HTTP: locally cached /vendor/supabase.js
  const VERSION = "2.118.0";
  const isLocalMediaServer = location.protocol === "http:";
  const src = isLocalMediaServer
    ? "/vendor/supabase.js"
    : `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${VERSION}/dist/umd/supabase.js`;

  // NOTE: this file is external JS, so a plain closing tag is safe here.
  // The previous `<\\/script>` produced a literal "<\/script>" that the HTML parser
  // does not treat as an end tag, so the following <script src="/js/config.js"> was
  // swallowed as text and config.js never executed.
  document.write(`<script src="${src}" crossorigin="anonymous"></` + `script>`);
})();
