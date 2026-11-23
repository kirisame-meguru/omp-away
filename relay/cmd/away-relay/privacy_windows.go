package main

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Only the process identity and Windows' trusted machine administrators may own
// the object or receive access. Reject conditional/object ACEs rather than trying
// to approximate their authorization semantics. Inherit-only grants count too:
// a private state directory must not create publicly readable database files.
func windowsDescriptorPrivate(sd *windows.SECURITY_DESCRIPTOR, user *windows.SID, directory bool) bool {
	if sd == nil || !sd.IsValid() || user == nil {
		return false
	}
	trusted := func(sid *windows.SID) bool {
		return sid != nil && sid.IsValid() && (sid.Equals(user) || sid.IsWellKnown(windows.WinLocalSystemSid) || sid.IsWellKnown(windows.WinBuiltinAdministratorsSid))
	}
	owner, _, err := sd.Owner()
	if err != nil || !trusted(owner) {
		return false
	}
	control, _, err := sd.Control()
	if err != nil || directory && control&windows.SE_DACL_PROTECTED == 0 {
		return false
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount == 0 {
		return false
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(dacl, i, &ace) != nil || ace == nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Header.AceSize < 16 {
			return false
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !trusted(sid) || sid.Len()+int(unsafe.Offsetof(ace.SidStart)) > int(ace.Header.AceSize) {
			return false
		}
	}
	return true
}

func windowsHandlePrivate(handle windows.Handle, directory bool) bool {
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || !directory && info.NumberOfLinks != 1 {
		return false
	}
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	return err == nil && windowsDescriptorPrivate(sd, user.User.Sid, directory)
}

func credentialPrivate(_ string, file *os.File, _ os.FileInfo) bool {
	return windowsHandlePrivate(windows.Handle(file.Fd()), false)
}

func statePrivate(name string, info os.FileInfo) bool {
	if info == nil {
		return false
	}
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return false
	}
	// Query the object itself without following a junction/symlink. os.SameFile
	// also binds the checked handle to the metadata used by the startup checks.
	handle, err := windows.CreateFile(path, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return false
	}
	file := os.NewFile(uintptr(handle), name)
	defer file.Close()
	opened, err := file.Stat()
	return err == nil && os.SameFile(info, opened) && windowsHandlePrivate(handle, info.IsDir())
}
