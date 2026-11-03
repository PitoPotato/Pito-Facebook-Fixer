# PitoFacebookFixer — Logo and language guidelines

## Identity

The mark extends the visual language of the user-provided PitoNote reference: an off-white rounded square, warm yellow inset and a dark P. The new inset is a conversation bubble, giving this application a messaging identity while remaining part of the Pito family. The geometry is original SVG; the reference bitmap is not bundled.

- Cream: `#F4F1E8`
- Warm yellow: `#F2D477`
- Graphite: `#313630`
- Existing indigo remains the functional UI accent. The logo colors stay identical in light and dark themes.

The P is drawn as vector geometry, not an installed font. No gradients, shadows or text effects. Keep the square proportions and at least 8 px clear space around a 32 px UI mark where the layout allows. Use the supplied icon at 16 px only for browser toolbar/favicon contexts; prefer 32 px or larger in the application.

## Files

- `extension/icons/logo.svg`: vector master used by options and popup.
- `extension/icons/icon-{16,24,32,48,128,256,512}.png`: transparent-corner exports for Chrome and sharing.
- `release/brand/`: distributable vector, PNGs, preview and this guide.
- Re-export with `node scripts/brand-assets.mjs`; this only opens an isolated temporary browser and uses no network or personal session.

## Language

English is the default, including when upgrading a settings record that has no language field. EN/VI is an explicit saved choice, independent of the browser's language. The language button sits immediately beside appearance controls in the options header and popup header.

Static copy is in `src/locales/static.json`; stateful copy is in `src/locales/messages.json`. Keep the same interpolation tokens in both languages. User message bodies are never translated. Locale-sensitive numbers and timestamps use en-US or vi-VN. Language changes update labels without replacing an active saved media player.

The story privacy feature remains disabled and labelled In development / Đang phát triển.
