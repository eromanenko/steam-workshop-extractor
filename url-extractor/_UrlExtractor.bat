set "INPUT=WorkshopUpload"
set "OUTPUT=_WorkshopUploadUrl.txt"


@echo off
pause 0
powershell -NoProfile -Command "$text = Get-Content 'WorkshopUpload' -Raw; $text = $text -replace '[\x00-\x1F]', ' '; [regex]::Matches($text, 'http[^""\s]+') | ForEach-Object { $_.Value } | Sort-Object -Unique | Set-Content '_Extracted.txt'"


setlocal enabledelayedexpansion

(
for /f "usebackq delims=" %%A in ("_Extracted.txt") do (
set "line=%%A"
set "line=!line:http://cloud-3.steamusercontent.com=https://steamusercontent-a.akamaihd.net!"
echo(!line!
)
) > "_Extracted_new.txt"
move /y "_Extracted_new.txt" "_Extracted.txt"

pause



