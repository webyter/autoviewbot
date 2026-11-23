{ pkgs }: {
    deps = [
        pkgs.nodejs
        pkgs.nodePackages.typescript
        pkgs.git
        pkgs.yarn
        pkgs.pm2
    ];
}
