$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SigningDirectory = Join-Path $ProjectRoot '.signing'
$KeystorePath = Join-Path $SigningDirectory 'lumecut-release.p12'
$PasswordPath = Join-Path $SigningDirectory 'lumecut-password.txt'

if ((Test-Path -LiteralPath $KeystorePath) -or (Test-Path -LiteralPath $PasswordPath)) {
    throw 'A chave já existe. Ela não foi sobrescrita.'
}

New-Item -ItemType Directory -Path $SigningDirectory -Force | Out-Null
$Alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%_-'
$Random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$Buffer = New-Object byte[] 48
$Random.GetBytes($Buffer)
$Password = -join ($Buffer | ForEach-Object { $Alphabet[$_ % $Alphabet.Length] })

$Rsa = [System.Security.Cryptography.RSA]::Create(4096)
$DistinguishedName = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=LumeCut Android, O=LumeCut')
$Request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    $DistinguishedName,
    $Rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$Request.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
        $true
    )
)
$Certificate = $Request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(30))
try { $Certificate.FriendlyName = 'lumecut' } catch { }
$PfxBytes = $Certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $Password)
[System.IO.File]::WriteAllBytes($KeystorePath, $PfxBytes)
[System.IO.File]::WriteAllText($PasswordPath, $Password, [System.Text.UTF8Encoding]::new($false))

$Certificate.Dispose()
$Rsa.Dispose()
$Random.Dispose()
Write-Output "Chave criada em $KeystorePath. Guarde a pasta .signing com segurança."
