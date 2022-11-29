#include "library.h"
#include <string.h>
#include <stdio.h>
void main() {
	char *data = "Some input data\n";
	lib_echo(data, strlen(data));
	printf("%d\n", lib_mul(1,2));
}
