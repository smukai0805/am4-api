# AdSense deployment handoff

AM4 does not include a publisher ID, an `ads.txt` file, advertising slots, or the Google AdSense script while no publisher ID is configured.

## After the publisher ID is issued

1. In the Vercel project environment settings, add `GOOGLE_ADSENSE_PUBLISHER_ID` with the actual publisher value. Use either `pub-` followed by the real 16-digit value or its `ca-pub-` form. Do not commit this setting to source control.
2. Redeploy, then confirm `/api/adsense.js` returns JavaScript only with the configured value. When the variable is absent or malformed, it returns `204 No Content` and no Google script is loaded. This URL is internally rewritten to an existing function so it does not increase the Vercel Hobby plan's function count.
3. Create the repository-root `ads.txt` with the actual publisher value only:

   ```text
   google.com, pub-<actual publisher ID>, DIRECT, f08c47fec0942fa0
   ```

4. Deploy and confirm `https://am4football.com/ads.txt` serves the exact line above.
5. Design any ad slots separately for editorial article bodies. Do not add them to the header, fixed navigation, MATCH CENTRE controls, match cards, scores, or status badges.

The publisher ID is intentionally public once used in the AdSense script and `ads.txt`, but it must never be replaced with a placeholder or fake value.
