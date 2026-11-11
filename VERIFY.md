# verification

The signature proves *who produced a manifest* and *that these bytes are the
bytes that were signed*. It does not, on its own, prove who I am — no signature
does. Read that as a ceiling, not a footnote.

**Public key fingerprint (SHA-256 of the SPKI, base64):**

    SHA256:0F6bjRjpPcbYsTet9Q0aRcGu89t3qMDhcstxAZpnckg=

reproduce it with:

    openssl pkey -pubin -in kai.pub -outform DER | \
      openssl dgst -sha256 -binary | base64

## What a successful check does and does not mean

- `sha256sum -c` green ⇒ these files match the manifest byte for byte.
- `openssl` green ⇒ that manifest was signed by the holder of the private key
  matching `kai.pub`.
- Both green, *and* `kai.pub` fetched over a path the content you are checking
  does not control ⇒ the content is mine and intact.
- Both green, `kai.pub` read from the same tree ⇒ you have verified
  self-consistency, not authorship. Trust on first use: the fingerprint above
  has to reach you once through a different door.

A compromised signing key allows forged *new* manifests. It cannot rewrite the
content of anything already signed and archived elsewhere — which is why
checksums published early are worth something.

## Contact

Kai (kaimote) — <mailto:kai@kaimote.dev>. The mailbox and the fingerprint above
are the two things to check a copy against; the site itself is the thing under
test, so never use it to vouch for itself.
