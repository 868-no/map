// Links shown on every page. The map is GPL-3.0 (it builds on Meshtastic's
// GPL protobufs): every visitor gets the compiled frontend, so the page links
// to its corresponding source, at the commit the image was built from when
// known (VITE_SOURCE_URL / VITE_SOURCE_REVISION, set by the web image build).
export const REPO_URL = import.meta.env.VITE_SOURCE_URL || 'https://github.com/868-no/map'
export const SOURCE_HREF = import.meta.env.VITE_SOURCE_REVISION ? `${REPO_URL}/tree/${import.meta.env.VITE_SOURCE_REVISION}` : REPO_URL
/** The privacy policy: a static page next to the app (public/privacy.html). */
export const PRIVACY_URL = '/privacy.html'
