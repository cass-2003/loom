; Workbench installer script (Inno Setup 6.5+)
; ASCII-only on purpose: all user-facing Chinese text comes from the language files
; (ChineseSimplified.isl / built-in {cm:...} messages), so this script needs no BOM.

#define MyAppName "Workbench"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Workbench"
#define MyAppExeName "Workbench.exe"
#define SrcDir RemoveBackslashUnlessRoot(ExtractFileDir(ExtractFileDir(SourcePath)))

[Setup]
; Stable AppId so future versions upgrade in place (do not change once shipped)
AppId={{6F3B9A2E-1C4D-4B7A-9E55-7A1F2C8D4B10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
; Per-user install -> no UAC / admin prompt; {autopf} maps to %LOCALAPPDATA%\Programs
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#SrcDir}\installer\Output
OutputBaseFilename=Workbench-Setup-{#MyAppVersion}
SetupIconFile={#SrcDir}\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force

[Languages]
Name: "chs"; MessagesFile: "{#SrcDir}\installer\ChineseSimplified.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Self-contained PyInstaller one-file binary + icon for the shortcuts
Source: "{#SrcDir}\dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Desktop entry follows Workbench's IDE-style workspace restore: explicit CLI root
; > previous workspace > welcome screen. Do not force Documents as a fake root.
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{userdocs}"; IconFilename: "{app}\icon.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{userdocs}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{userdocs}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
