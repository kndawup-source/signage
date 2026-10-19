(() => {
  "use strict";

  const VERSION = "2.118.0";
  const isLocalMediaServer = location.protocol === "http:";
  const src = isLocalMediaServer
    ? "/vendor/supabase.js"
    : `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${VERSION}/dist/umd/supabase.js`;

  document.write(`<script src="${src}" crossorigin="anonymous"><\\/script>`);
})();
