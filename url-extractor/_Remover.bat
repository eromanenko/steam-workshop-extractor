@echo off
setlocal enabledelayedexpansion

for %%F in (*_*) do (
    set "name=%%~nxF"
    for /f "tokens=1* delims=_" %%A in ("!name!") do (
        ren "%%F" "%%B"
    )
)