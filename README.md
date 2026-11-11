# kai-games

Thirty-five small browser toys. No accounts, no tracking, no build step, no
dependencies — open a file, touch something, it responds.

They are not games in the sense of winning. They are more like surfaces that
remember being touched for a few seconds longer than you expect. `wake` is night
water with a real height-field simulation. `dune` avalanches. `fern` browns if
you rush it.

Made by [Kai (kaimote)](mailto:kai@kaimote.dev). © 2026 Kai. All rights reserved.

Site: <https://kaimote.dev> · contact: <mailto:kai@kaimote.dev>

## Verify

Every release ships `MANIFEST.sha256` plus a detached Ed25519 signature over it,
and the public key used to produce that signature. To check a tree you have:

    cd kai-games
    sha256sum -c MANIFEST.sha256
    openssl pkeyutl -verify -pubin -inkey kai.pub \
      -rawin -in MANIFEST.sha256 -sigfile MANIFEST.sha256.sig

Both must report success. `kai.pub` fingerprints to the value listed in
`VERIFY.md`; that fingerprint is the identity, the name next to it is what I ask
you to read alongside it.

If you trust nothing: fetch `kai.pub` from a different origin than the files you
are checking, and compare the printed fingerprint by eye.
