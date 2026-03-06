# bd-slew: Recordit DMG Install UX Flow

## Scope

`bd-slew` updates DMG packaging so the mounted installer surface presents:

- `Recordit.app` as the primary app payload
- `Applications` as an explicit drag-to-install destination

Implemented via:

- `scripts/create_recordit_dmg.sh`
- `Makefile` target `create-recordit-dmg`
- `README.md` command reference for DMG creation

## Commands Run

```bash
bash -n scripts/create_recordit_dmg.sh
make create-recordit-dmg RECORDIT_DMG_NAME=Recordit-bd-slew.dmg RECORDIT_DMG_VOLNAME='Recordit Beta'
```

Mount inspection:

```bash
hdiutil attach dist/Recordit-bd-slew.dmg -nobrowse -readonly -mountpoint <tmp-mount>
ls -la <tmp-mount>
readlink <tmp-mount>/Applications
hdiutil detach <tmp-mount>
```

## Evidence

Build + package:

- `xcodebuild ... -project Recordit.xcodeproj -scheme RecorditApp ...` -> `** BUILD SUCCEEDED **`
- `scripts/create_recordit_dmg.sh ...` -> `created: /Users/themrb/Documents/1_projects/recordit/dist/Recordit-bd-slew.dmg`

Mounted DMG contents:

```text
Applications -> /Applications
Recordit.app/
```

Assertions observed during run:

- `MOUNT_HAS_RECORDIT_APP=1`
- `MOUNT_HAS_APPLICATIONS_SYMLINK=1`
- `readlink Applications` -> `/Applications`

## Result

`bd-slew` acceptance criteria satisfied: the DMG mount layout now exposes an explicit Recordit drag-to-Applications install UX.
