import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct ImageSaver {
    static func saveImage(_ image: CGImage, to path: String, format: ImageFormat) throws(CaptureError) {
        let url = URL(fileURLWithPath: path)

        // Check if the parent directory exists
        let directory = url.deletingLastPathComponent()
        var isDirectory: ObjCBool = false
        if !FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            let error = NSError(
                domain: NSCocoaErrorDomain,
                code: NSFileNoSuchFileError,
                userInfo: [NSLocalizedDescriptionKey: "No such file or directory"]
            )
            throw CaptureError.fileWriteError(path, error)
        }

        let utType: UTType = format == .png ? .png : .jpeg
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            utType.identifier as CFString,
            1,
            nil
        ) else {
            // Try to create a more specific error for common cases
            if !FileManager.default.isWritableFile(atPath: directory.path) {
                let error = NSError(
                    domain: NSPOSIXErrorDomain,
                    code: Int(EACCES),
                    userInfo: [NSLocalizedDescriptionKey: "Permission denied"]
                )
                throw CaptureError.fileWriteError(path, error)
            }
            throw CaptureError.fileWriteError(path, nil)
        }

        CGImageDestinationAddImage(destination, image, nil)

        guard CGImageDestinationFinalize(destination) else {
            throw CaptureError.fileWriteError(path, nil)
        }
    }
}
