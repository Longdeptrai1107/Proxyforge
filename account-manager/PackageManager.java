import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;

/** Builds one executable jar containing the manager, emulator and rebuilt game. */
public final class PackageManager {
    public static void main(String[] args) throws Exception {
        Path root = Path.of(args[0]), classes = root.resolve("account-manager/bin/java");
        Manifest manifest = new Manifest();
        manifest.getMainAttributes().putValue("Manifest-Version", "1.0");
        manifest.getMainAttributes().putValue("Main-Class", "NroAccountManager");
        Path staged = root.resolve("QLTK.building.jar"); Set<String> names = new HashSet<>(); names.add("META-INF/MANIFEST.MF");
        try (JarOutputStream output = new JarOutputStream(Files.newOutputStream(staged), manifest)) {
            output.setLevel(9);
            try (JarFile emulator = new JarFile(root.resolve("lib/microemulator-2.0.4.jar").toFile())) {
                for (Enumeration<JarEntry> entries = emulator.entries(); entries.hasMoreElements();) {
                    JarEntry entry = entries.nextElement(); String name = entry.getName();
                    if (entry.isDirectory() || name.equalsIgnoreCase("META-INF/MANIFEST.MF")
                        || name.matches("(?i)META-INF/.*\\.(SF|RSA|DSA)")) continue;
                    try (InputStream input = emulator.getInputStream(entry)) { add(output, names, name, input.readAllBytes()); }
                }
            }
            try (var files = Files.walk(classes)) {
                for (Path file : files.filter(p -> Files.isRegularFile(p) && p.toString().endsWith(".class")).sorted().toList())
                    add(output, names, classes.relativize(file).toString().replace('\\', '/'), Files.readAllBytes(file));
            }
            for (String name : List.of("DragonBoy252-source-rebuilt.jar", "DragonBoy252-source-rebuilt.jad"))
                add(output, names, "runtime/" + name, Files.readAllBytes(root.resolve("dist").resolve(name)));
            add(output, names, "THIRD_PARTY_NOTICES.md", Files.readAllBytes(root.resolve("THIRD_PARTY_NOTICES.md")));
            add(output, names, "LICENSE.md", Files.readAllBytes(root.resolve("LICENSE.md")));
            try (var licenses = Files.walk(root.resolve("LICENSES"))) {
                for (Path file : licenses.filter(Files::isRegularFile).sorted().toList())
                    add(output, names, "LICENSES/" + file.getFileName(), Files.readAllBytes(file));
            }
        }
        try (JarFile verification = new JarFile(staged.toFile())) {
            if (!"NroAccountManager".equals(verification.getManifest().getMainAttributes().getValue("Main-Class"))
                || verification.getEntry("EmulatorBootstrap.class") == null
                || verification.getEntry("org/microemu/app/Main.class") == null
                || verification.getEntry("runtime/DragonBoy252-source-rebuilt.jar") == null)
                throw new IOException("Standalone package verification failed");
        }
        Path target = args.length > 1 ? root.resolve(args[1]).toAbsolutePath() : root.resolve("release/QLTK.jar");
        Files.createDirectories(target.getParent());
        Files.move(staged, target, StandardCopyOption.REPLACE_EXISTING);
        System.out.println("Built standalone " + target + ": " + Files.size(target) + " bytes");
    }
    static void add(JarOutputStream output, Set<String> names, String name, byte[] bytes) throws IOException {
        if (!names.add(name)) throw new IOException("Duplicate package entry: " + name);
        JarEntry entry = new JarEntry(name); entry.setTime(0); output.putNextEntry(entry); output.write(bytes); output.closeEntry();
    }
}
