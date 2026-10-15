# Registers a portable VShoon folder with the Windows shell.
#
# The application sets its AppUserModelID (`product.json` `win32AppUserModelId`) at startup. Windows
# resolves the taskbar and jump list icon of such a window through the Start Menu shortcut that
# carries the same ID, so a shortcut left behind by a moved portable folder makes the taskbar icon
# disappear. This script points one Start Menu shortcut at the given folder, stamps it with the ID
# and removes other shortcuts with that ID whose target no longer exists.
#
#   npm run portable:register -- -PortablePath 'D:\vs Hoon'

[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$PortablePath
)

$ErrorActionPreference = 'Stop'

$resolvedPortablePath = (Resolve-Path -LiteralPath $PortablePath).Path
$productPath = Join-Path $resolvedPortablePath 'resources\app\product.json'
if (-not (Test-Path -LiteralPath $productPath)) {
	throw "Not a packaged VShoon folder: $productPath is missing."
}
$product = Get-Content -LiteralPath $productPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appUserModelId = $product.win32AppUserModelId
$nameShort = $product.nameShort
$executablePath = Join-Path $resolvedPortablePath ($product.nameShort + '.exe')
if (-not $appUserModelId -or -not (Test-Path -LiteralPath $executablePath)) {
	throw "product.json does not describe an executable in $resolvedPortablePath."
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VShoonShortcut {
	[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
	private class ShellLink { }

	[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
	private interface IShellLinkW {
		void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maxPath, IntPtr findData, uint flags);
		void GetIDList(out IntPtr idList);
		void SetIDList(IntPtr idList);
		void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maxName);
		void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
		void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int maxPath);
		void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
		void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int maxPath);
		void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
		void GetHotkey(out short hotkey);
		void SetHotkey(short hotkey);
		void GetShowCmd(out int showCmd);
		void SetShowCmd(int showCmd);
		void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int maxIconPath, out int icon);
		void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int icon);
		void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pathRel, uint reserved);
		void Resolve(IntPtr hwnd, uint flags);
		void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
	}

	[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
	private interface IPersistFile {
		void GetClassID(out Guid classId);
		[PreserveSig] int IsDirty();
		void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
		void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
		void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
		void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
	}

	[StructLayout(LayoutKind.Sequential, Pack = 4)]
	private struct PropertyKey {
		public Guid FormatId;
		public int PropertyId;
	}

	[StructLayout(LayoutKind.Explicit, Size = 24)]
	private struct PropVariant {
		[FieldOffset(0)] public ushort VarType;
		[FieldOffset(8)] public IntPtr Pointer;
	}

	[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
	private interface IPropertyStore {
		void GetCount(out uint count);
		void GetAt(uint index, out PropertyKey key);
		void GetValue(ref PropertyKey key, out PropVariant value);
		void SetValue(ref PropertyKey key, ref PropVariant value);
		void Commit();
	}

	[DllImport("ole32.dll")]
	private static extern int PropVariantClear(ref PropVariant value);

	public static void Write(string shortcutPath, string targetPath, string workingDirectory, string description, string appUserModelId) {
		IShellLinkW link = (IShellLinkW)new ShellLink();
		link.SetPath(targetPath);
		link.SetWorkingDirectory(workingDirectory);
		link.SetDescription(description);
		link.SetIconLocation(targetPath, 0);

		// PKEY_AppUserModel_ID
		PropertyKey key = new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
		PropVariant value = new PropVariant { VarType = 31 /* VT_LPWSTR */, Pointer = Marshal.StringToCoTaskMemUni(appUserModelId) };
		try {
			IPropertyStore store = (IPropertyStore)link;
			store.SetValue(ref key, ref value);
			store.Commit();
		} finally {
			PropVariantClear(ref value);
		}
		((IPersistFile)link).Save(shortcutPath, true);
	}
}
'@

$programsPath = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $programsPath ($nameShort + '.lnk')

# Shortcuts that claim the same ID but launch a folder that is gone are what hides the icon.
$wscript = New-Object -ComObject WScript.Shell
$shellApplication = New-Object -ComObject Shell.Application
$programsFolder = $shellApplication.Namespace($programsPath)
Get-ChildItem -LiteralPath $programsPath -Filter '*.lnk' -File | ForEach-Object {
	if ($_.FullName -eq $shortcutPath) {
		return
	}
	$item = $programsFolder.ParseName($_.Name)
	if ($item.ExtendedProperty('System.AppUserModel.ID') -ne $appUserModelId) {
		return
	}
	$target = $wscript.CreateShortcut($_.FullName).TargetPath
	if ($target -and -not (Test-Path -LiteralPath $target)) {
		Remove-Item -LiteralPath $_.FullName
		Write-Host "Removed stale shortcut $($_.FullName) -> $target"
	}
}

[VShoonShortcut]::Write($shortcutPath, $executablePath, $resolvedPortablePath, $nameShort, $appUserModelId)
Write-Host "Registered $shortcutPath -> $executablePath (AppUserModelID $appUserModelId)"

# Explorer caches the resolved icon per ID; a restart of the taskbar is not needed, but the
# change is only picked up by windows opened after this point.
