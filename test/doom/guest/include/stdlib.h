#pragma once
#include <stddef.h>
void *malloc(size_t n);
void *calloc(size_t n, size_t size);
void *realloc(void *p, size_t n);
void free(void *p);
void exit(int code) __attribute__((noreturn));
int abs(int v);
int atoi(const char *s);
double atof(const char *s);
int system(const char *cmd);
