# Recreates runtime/python: an embeddable CPython + the wheels the engine needs.
# Used by electron-builder's extraResources so the shipped app needs no system Python.
$ErrorActionPreference = "Stop"

$ver = "3.13.11"
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root "runtime"
$python = Join-Path $runtime "python"
$site = Join-Path $python "Lib\site-packages"
$zip = Join-Path $env:TEMP "python-$ver-embed-amd64.zip"

if (Test-Path $python) {
    Write-Host "runtime/python ya existe; borrando"
    Remove-Item $python -Recurse -Force
}
New-Item -ItemType Directory -Path $python -Force | Out-Null

$url = "https://www.python.org/ftp/python/$ver/python-$ver-embed-amd64.zip"
Write-Host "descargando $url"
curl.exe -L --fail --silent --show-error -o $zip $url
Expand-Archive -Path $zip -DestinationPath $python -Force

$pth = Get-ChildItem $python -Filter "python*._pth" | Select-Object -First 1
$content = "python313.zip`r`n.`r`nLib\site-packages`r`nimport site`r`n"
[System.IO.File]::WriteAllText($pth.FullName, $content, [System.Text.ASCIIEncoding]::new())
New-Item -ItemType Directory -Path $site -Force | Out-Null

$pip = Get-Command python -ErrorAction SilentlyContinue
if (-not $pip) { throw "Necesitas un Python con pip en PATH para instalar los wheels destino" }
& python -m pip install --quiet --no-warn-script-location --target $site --only-binary :all: `
    shapely ezdxf reportlab pillow numpy opencv-python-headless pymupdf pypdf

Remove-Item (Join-Path $site "onnxruntime*") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $site "cv2\opencv_videoio_ffmpeg*_64.dll") -Force -ErrorAction SilentlyContinue
Get-ChildItem $site -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

& (Join-Path $python "python.exe") -c "import fitz,shapely,ezdxf,reportlab,PIL,numpy,cv2,pypdf;print('runtime OK')"
$mb = [math]::Round(((Get-ChildItem $runtime -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 0)
Write-Host "listo: $runtime ($mb MB)"
