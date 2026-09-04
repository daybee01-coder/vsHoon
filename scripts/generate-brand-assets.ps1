# VShoon owns the generated brand files. `logo.png` in the repository root is the
# master artwork and the only source of truth; every Windows size, the workbench
# icon and the start window mark are regenerated from it.

[CmdletBinding()]
param(
	[string]$MasterPath,
	[string]$OutputDirectory,
	[string]$StartWindowLogoPath,
	[string]$WorkbenchIconPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not $MasterPath) {
	$MasterPath = Join-Path $PSScriptRoot '..\logo.png'
}
if (-not $OutputDirectory) {
	$OutputDirectory = Join-Path $PSScriptRoot '..\resources\win32'
}
if (-not $StartWindowLogoPath) {
	$StartWindowLogoPath = Join-Path $PSScriptRoot '..\src\vs\vshoon\electron-sandbox\startWindow\vshoon-logo.png'
}
if (-not $WorkbenchIconPath) {
	$WorkbenchIconPath = Join-Path $PSScriptRoot '..\src\vs\workbench\browser\media\code-icon.svg'
}

$resolvedMasterPath = (Resolve-Path -LiteralPath $MasterPath).Path
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$resolvedStartWindowLogoPath = [System.IO.Path]::GetFullPath($StartWindowLogoPath)
$resolvedWorkbenchIconPath = [System.IO.Path]::GetFullPath($WorkbenchIconPath)
[System.IO.Directory]::CreateDirectory($resolvedOutputDirectory) | Out-Null
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedStartWindowLogoPath)) | Out-Null
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedWorkbenchIconPath)) | Out-Null

<#
.SYNOPSIS
Crops the fully transparent margin off the master so every generated size centres
the mark itself rather than whatever padding the artwork happens to carry.
#>
function New-TrimmedBitmap {
	param([System.Drawing.Image]$Source, [int]$AlphaThreshold = 8)

	$bitmap = New-Object System.Drawing.Bitmap($Source)
	$bounds = New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)
	$data = $bitmap.LockBits($bounds, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$bytes = New-Object byte[] ($data.Stride * $bitmap.Height)
	[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
	$stride = $data.Stride
	$bitmap.UnlockBits($data)

	$minX = $bitmap.Width; $minY = $bitmap.Height; $maxX = -1; $maxY = -1
	for ($y = 0; $y -lt $bitmap.Height; $y++) {
		$row = $y * $stride
		for ($x = 0; $x -lt $bitmap.Width; $x++) {
			if ($bytes[$row + $x * 4 + 3] -ge $AlphaThreshold) {
				if ($x -lt $minX) { $minX = $x }
				if ($x -gt $maxX) { $maxX = $x }
				if ($y -lt $minY) { $minY = $y }
				if ($y -gt $maxY) { $maxY = $y }
			}
		}
	}

	if ($maxX -lt $minX -or $maxY -lt $minY) {
		return $bitmap
	}

	$crop = New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))
	try {
		return $bitmap.Clone($crop, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	} finally {
		$bitmap.Dispose()
	}
}

<#
.SYNOPSIS
Draws the mark centred inside a box of the requested size, preserving its aspect
ratio so a wider-than-tall master is never stretched into a square.
#>
function New-ResizedPngBytes {
	param(
		[System.Drawing.Image]$Source,
		[int]$Width,
		[int]$Height,
		[System.Drawing.Color]$Background = [System.Drawing.Color]::Transparent,
		[double]$Scale = 1.0
	)

	$bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
	$stream = New-Object System.IO.MemoryStream
	try {
		$graphics.Clear($Background)
		$graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
		$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
		$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
		$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
		$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

		$ratio = [Math]::Min(($Width * $Scale) / $Source.Width, ($Height * $Scale) / $Source.Height)
		$drawWidth = [Math]::Max(1, [int][Math]::Round($Source.Width * $ratio))
		$drawHeight = [Math]::Max(1, [int][Math]::Round($Source.Height * $ratio))
		$x = [int][Math]::Floor(($Width - $drawWidth) / 2)
		$y = [int][Math]::Floor(($Height - $drawHeight) / 2)
		$graphics.DrawImage($Source, $x, $y, $drawWidth, $drawHeight)
		$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
		return $stream.ToArray()
	} finally {
		$stream.Dispose()
		$graphics.Dispose()
		$bitmap.Dispose()
	}
}

function Write-Bytes {
	param([string]$Path, [byte[]]$Bytes)
	[System.IO.File]::WriteAllBytes($Path, $Bytes)
}

<#
.SYNOPSIS
Writes the mark as an SVG so it can replace a core icon that stylesheets load by name.

The workbench loads `code-icon.svg` from half a dozen stylesheets - the title bar, the banner,
the Welcome page, the update tooltip. Upstream's own release build overlays that same file with
its branded icon, so VShoon does too rather than patching every stylesheet. The artwork is a
raster with gradients, so the SVG carries it as an embedded image.
#>
function Write-Svg {
	param([string]$Path, [System.Drawing.Image]$Source, [int]$Size)

	$encoded = [System.Convert]::ToBase64String((New-ResizedPngBytes -Source $Source -Width $Size -Height $Size))
	$svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 SIZE SIZE" width="SIZE" height="SIZE"><image width="SIZE" height="SIZE" href="data:image/png;base64,DATA"/></svg>'
	$svg = $svg.Replace('SIZE', $Size).Replace('DATA', $encoded)
	# LF, not the platform newline: the repository stores every text file with LF, so a CRLF
	# here would make Git rewrite the file and every regeneration would look like a change.
	[System.IO.File]::WriteAllText($Path, ($svg + "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

function Write-Ico {
	param([string]$Path, [System.Drawing.Image]$Source, [int[]]$Sizes)

	$frames = [System.Collections.Generic.List[byte[]]]::new()
	foreach ($size in $Sizes) {
		$frames.Add((New-ResizedPngBytes -Source $Source -Width $size -Height $size -Scale 0.92))
	}
	$stream = New-Object System.IO.MemoryStream
	$writer = New-Object System.IO.BinaryWriter($stream)
	try {
		$writer.Write([uint16]0)
		$writer.Write([uint16]1)
		$writer.Write([uint16]$frames.Count)
		$offset = 6 + (16 * $frames.Count)
		for ($index = 0; $index -lt $frames.Count; $index++) {
			$size = $Sizes[$index]
			$frame = $frames[$index]
			$writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
			$writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
			$writer.Write([byte]0)
			$writer.Write([byte]0)
			$writer.Write([uint16]1)
			$writer.Write([uint16]32)
			$writer.Write([uint32]$frame.Length)
			$writer.Write([uint32]$offset)
			$offset += $frame.Length
		}
		foreach ($frame in $frames) {
			$writer.Write($frame)
		}
		$writer.Flush()
		Write-Bytes -Path $Path -Bytes $stream.ToArray()
	} finally {
		$writer.Dispose()
		$stream.Dispose()
	}
}

function Write-Bmp {
	param(
		[string]$Path,
		[System.Drawing.Image]$Source,
		[int]$Width,
		[int]$Height,
		[double]$Scale
	)

	$pngBytes = New-ResizedPngBytes -Source $Source -Width $Width -Height $Height -Background ([System.Drawing.Color]::White) -Scale $Scale
	$input = New-Object System.IO.MemoryStream(, $pngBytes)
	$image = [System.Drawing.Image]::FromStream($input)
	$bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
	$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
	try {
		$graphics.Clear([System.Drawing.Color]::White)
		$graphics.DrawImageUnscaled($image, 0, 0)
		$bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
	} finally {
		$graphics.Dispose()
		$bitmap.Dispose()
		$image.Dispose()
		$input.Dispose()
	}
}

$master = [System.Drawing.Image]::FromFile($resolvedMasterPath)
try {
	$mark = New-TrimmedBitmap -Source $master
} finally {
	$master.Dispose()
}

try {
	Write-Ico -Path (Join-Path $resolvedOutputDirectory 'code.ico') -Source $mark -Sizes @(16, 24, 32, 48, 64, 128, 256)
	Write-Bytes -Path (Join-Path $resolvedOutputDirectory 'code_70x70.png') -Bytes (New-ResizedPngBytes -Source $mark -Width 70 -Height 70 -Scale 0.92)
	Write-Bytes -Path (Join-Path $resolvedOutputDirectory 'code_150x150.png') -Bytes (New-ResizedPngBytes -Source $mark -Width 150 -Height 150 -Scale 0.92)
	Write-Bytes -Path $resolvedStartWindowLogoPath -Bytes (New-ResizedPngBytes -Source $mark -Width 256 -Height 256)
	Write-Svg -Path $resolvedWorkbenchIconPath -Source $mark -Size 256

	$wizardSizes = @(
		@('100', 164, 314, 55, 55),
		@('125', 192, 386, 64, 68),
		@('150', 246, 459, 83, 80),
		@('175', 273, 556, 92, 97),
		@('200', 328, 604, 110, 106),
		@('225', 355, 700, 119, 123),
		@('250', 410, 797, 138, 140)
	)
	foreach ($size in $wizardSizes) {
		Write-Bmp -Path (Join-Path $resolvedOutputDirectory "inno-big-$($size[0]).bmp") -Source $mark -Width $size[1] -Height $size[2] -Scale 0.70
		Write-Bmp -Path (Join-Path $resolvedOutputDirectory "inno-small-$($size[0]).bmp") -Source $mark -Width $size[3] -Height $size[4] -Scale 0.86
	}
} finally {
	$mark.Dispose()
}

Write-Host "[vshoon] generated Windows brand assets in $resolvedOutputDirectory"
Write-Host "[vshoon] generated the start window mark at $resolvedStartWindowLogoPath"
Write-Host "[vshoon] generated the workbench icon at $resolvedWorkbenchIconPath"
