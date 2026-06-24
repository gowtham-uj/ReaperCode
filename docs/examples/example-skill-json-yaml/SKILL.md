# JSON ↔ YAML

Convert between JSON and YAML formats.

## Steps

1. Read the input file with `read_file --path $ARGUMENTS.path`.
2. If `$ARGUMENTS.direction == "json-to-yaml"`, run
   `python3 -c "import json, yaml; print(yaml.dump(json.load(open('$ARGUMENTS.path'))))"`.
3. If `yaml-to-json`, run
   `python3 -c "import json, yaml; print(json.dumps(yaml.safe_load(open('$ARGUMENTS.path'))))"`.
4. Write the result to a sibling file with the new extension.

## When NOT to use

- CSV / TSV / TOML — wrong format.
- Binary formats (`.proto`, `.msgpack`).
- Pure data validation (use a schema skill instead).

## Validation

`reaper skill test json-yaml` runs `node -e "..."` to confirm
`examples/after.yaml` is valid YAML.
