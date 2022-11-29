# fpicker-mod

In the past used it to refind Stagefright bug CVE 2020-0411 within hours (several months after being 0 day)

Tested 29/11/2022 on Android 12 x86_64 (think x86) in emulator (docker) on x86_64 host

Lost source for modified AFL++ (I think the attached AFL++ source is it, but not sure 100% .... check all the linked libs in GNUMakefile), binary is there

Put everything in /data/local/tmp

run  support-sock-x86_64 to create mysocket in  /data/local/tmp

Download Frida Server

Start frida server

copy libandroid-shmem.so to re.frida.server

make sure all paths are allright

start test from examples (it will be a daemon process)

start like in cmd.txt

