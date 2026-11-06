// Links about the site itself (in the app menu). The map is GPL-3.0 (it
// builds on Meshtastic's GPL protobufs): every visitor gets the compiled
// frontend, so it links to its corresponding source, at the commit the image
// was built from when known (VITE_SOURCE_URL / VITE_SOURCE_REVISION, set by
// the web image build).
const REPO_URL = import.meta.env.VITE_SOURCE_URL || 'https://github.com/868-no/map'
export const SOURCE_REVISION = import.meta.env.VITE_SOURCE_REVISION || ''
export const SOURCE_HREF = SOURCE_REVISION ? `${REPO_URL}/tree/${SOURCE_REVISION}` : REPO_URL
/** The commit itself, for the version line in Settings. */
export const REVISION_HREF = SOURCE_REVISION ? `${REPO_URL}/commit/${SOURCE_REVISION}` : ''
export const LICENSE_HREF = `${REPO_URL}/blob/${SOURCE_REVISION || 'main'}/LICENSE`
/** The privacy policy: a static page next to the app (public/privacy.html). */
export const PRIVACY_URL = '/privacy.html'
