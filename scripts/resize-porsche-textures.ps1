param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$jobs=Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
$results=@()
foreach($job in $jobs){
  $source=[System.Drawing.Bitmap]::new([string]$job.input)
  $factor=[Math]::Min([double]1,[double]$job.cap/[Math]::Max($source.Width,$source.Height))
  $width=[Math]::Max(1,[int][Math]::Round($source.Width*$factor));$height=[Math]::Max(1,[int][Math]::Round($source.Height*$factor))
  if([Math]::Abs($width/$height-$source.Width/$source.Height) -gt .05){throw "Texture aspect ratio changed: $($job.input)"}
  $image=[System.Drawing.Bitmap]::new($width,$height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics=[System.Drawing.Graphics]::FromImage($image)
  $graphics.CompositingMode=[System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $attributes=[System.Drawing.Imaging.ImageAttributes]::new();$attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $graphics.DrawImage($source,[System.Drawing.Rectangle]::new(0,0,$width,$height),0,0,$source.Width,$source.Height,[System.Drawing.GraphicsUnit]::Pixel,$attributes)
  $graphics.Dispose();$attributes.Dispose()
  $rect=[System.Drawing.Rectangle]::new(0,0,$width,$height)
  $locked=$image.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bytes=[byte[]]::new([Math]::Abs($locked.Stride)*$height);[System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0,$bytes,0,$bytes.Length);$image.UnlockBits($locked)
  $opaque=$true
  for($i=3;$i -lt $bytes.Length;$i+=4){if($bytes[$i] -lt 255){$opaque=$false;break}}
  $jpeg=$job.jpeg -and $opaque -and ($width*$height -gt 16384)
  $output=[string]$job.output+$(if($jpeg){'.jpg'}else{'.png'})
  if($factor -eq 1 -and -not $jpeg -and $source.RawFormat.Guid -eq [System.Drawing.Imaging.ImageFormat]::Png.Guid){
    Copy-Item -LiteralPath ([string]$job.input) -Destination $output -Force
  }elseif($jpeg){
    $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
    $parameters=[System.Drawing.Imaging.EncoderParameters]::new(1);$parameters.Param[0]=[System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality,[long]93)
    $image.Save($output,$codec,$parameters);$parameters.Dispose()
  }else{$image.Save($output,[System.Drawing.Imaging.ImageFormat]::Png)}
  $results+=@{index=$job.index;path=$output;width=$width;height=$height;originalWidth=$source.Width;originalHeight=$source.Height;mime=$(if($jpeg){'image/jpeg'}else{'image/png'})}
  $image.Dispose();$source.Dispose()
}
ConvertTo-Json -InputObject @($results) -Depth 4 | Set-Content -LiteralPath ($Plan+'.results.json') -Encoding UTF8
